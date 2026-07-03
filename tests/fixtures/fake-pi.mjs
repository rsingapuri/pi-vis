#!/usr/bin/env node
/**
 * Scripted stand-in for `pi --mode rpc`.
 * Reads JSONL on stdin; responds on stdout.
 *
 * Protocol-correct event shapes (matches src/shared/pi-protocol/events.ts):
 *   - message_start/update/end carry `message: { role }`
 *   - message_update carries `assistantMessageEvent: { type, delta, ... }`
 *   - tool_execution_* use `args` / `partialResult` / `result` (not input/output)
 *
 * Persists sessions to JSONL files so e2e can test durability:
 *   - Mirrors real pi's layout: <sessionsDir>/<encodedCwd>/<timestamp>_<uuid>.jsonl
 *   - File is lazy — only created on the first prompt.
 *   - `set_session_name` appends a `session_info` entry; the name survives resume.
 *
 * Behaviors keyed by prompt content (lowercased):
 *   "hello"    → streamed text "Hello! I'm your pi coding agent."
 *   "use-tool" → tool_execution sequence + "Done reading."
 *   "ask-me"   → select dialog roundtrip
 *   anything else → "Echo: <message>"
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";

// ── CLI args ──────────────────────────────────────────────────────────────

/**
 * A test-pinned version, or null when unpinned. Update tests need a binary
 * whose version *changes* after `update` runs, so the version is read from a
 * stamp file when FAKE_PI_VERSION_FILE points at one (falling back to
 * FAKE_PI_VERSION). `update` rewrites that file, and the follow-up `--version`
 * re-check sees the new value. When pinned, `--version` prints the *bare*
 * version so it parses as semver (real `pi --version` does the same);
 * unpinned, it prints the recognizable "fake-pi 1.0.0".
 */
function readPinnedVersion() {
  const file = process.env.FAKE_PI_VERSION_FILE;
  if (file) {
    try {
      const v = fs.readFileSync(file, "utf8").trim();
      if (v) return v;
    } catch {
      // stamp not written yet — fall through
    }
  }
  return process.env.FAKE_PI_VERSION ?? null;
}

if (process.argv.includes("--version")) {
  const pinned = readPinnedVersion();
  process.stdout.write(pinned ? `${pinned}\n` : "fake-pi 1.0.0\n");
  process.exit(0);
}

// `pi update [pi | --extension <src>] [--no-approve]` — a one-shot CLI
// command, not RPC. Simulate progress, then either fail, hang, or bump the
// version stamp so the post-update version re-check observes the new value.
//   FAKE_PI_UPDATE_HANG=1      → never exit (exercises the safety timeout)
//   FAKE_PI_UPDATE_EXIT=<n>    → exit <n> without bumping the version
//   FAKE_PI_UPDATE_TO=<ver>    → version to write on success (default "2.0.0")
if (process.argv.includes("update")) {
  // Echo the resolved argv so tests can assert the exact `update` flags
  // (e.g. that "all" maps to `--all` and so includes extensions, not the
  // bare `pi update` that silently skips them).
  process.stdout.write(`ARGV ${process.argv.slice(2).join(" ")}\n`);
  process.stdout.write("Checking for updates...\n");
  if (process.env.FAKE_PI_UPDATE_HANG === "1") {
    // Hang forever; the parent's safety timeout should kill us.
    setInterval(() => {}, 1 << 30);
  } else {
    const exitOverride = process.env.FAKE_PI_UPDATE_EXIT;
    setTimeout(() => {
      if (exitOverride !== undefined) {
        process.stderr.write("Update failed.\n");
        process.exit(Number.parseInt(exitOverride, 10) || 1);
      }
      const to = process.env.FAKE_PI_UPDATE_TO ?? "2.0.0";
      if (process.env.FAKE_PI_VERSION_FILE) {
        fs.writeFileSync(process.env.FAKE_PI_VERSION_FILE, `${to}\n`);
      }
      process.stdout.write(`Updated pi to ${to}\n`);
      process.exit(0);
    }, 20);
  }
}

function argValue(flag) {
  const idx = process.argv.indexOf(flag);
  if (idx === -1 || idx === process.argv.length - 1) return undefined;
  return process.argv[idx + 1];
}

const sessionFileArg = argValue("--session");
const sessionDirArg =
  argValue("--session-dir") ??
  process.env.FAKE_PI_SESSIONS_DIR ??
  path.join(os.tmpdir(), "fake-pi-sessions");

// ── Module state ──────────────────────────────────────────────────────────

let sessionId;
let sessionFile;
let sessionName = null;
let pendingName = null;
let lastEntryId = null;
let fileCreated = false;
let currentThinkingLevel = "off";
let currentModelId = "fake-model";

const fakeModels = [
  {
    id: "fake-model",
    name: "Fake Model",
    api: "fake",
    provider: "fake",
    reasoning: false,
  },
  {
    id: "fake-model-2",
    name: "Fake Model Two",
    api: "fake",
    provider: "fake",
    reasoning: true,
  },
];

function currentModel() {
  return fakeModels.find((m) => m.id === currentModelId) ?? fakeModels[0];
}
// Fork / switch / new-session bookkeeping for parity with real pi.
let userMessagesForForking = []; // [{ entryId, text }]
let lastAssistantText = null;
let isCompacting = false;
let switchSessionCancelled = false;
let newSessionCancelled = false;
let forkResolution = null; // { file, text } when a fork resolves

// Resolve session identity. With --session, reuse the file. Without, build a
// path that mirrors real pi's layout (encoded-cwd subdirectory required so
// the app's session-discovery only needs one level of recursion).
if (sessionFileArg) {
  sessionFile = sessionFileArg;
  if (fs.existsSync(sessionFile)) {
    const content = fs.readFileSync(sessionFile, "utf8");
    const lines = content.split("\n");
    // Line 1: header
    try {
      const header = JSON.parse(lines[0]);
      sessionId = header.id;
    } catch {
      sessionId = crypto.randomUUID();
    }
    fileCreated = true;
    // Walk remaining lines, tracking last entry id and last session_info name.
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof entry.id === "string" && entry.id) {
        lastEntryId = entry.id;
      }
      if (entry.type === "session_info" && typeof entry.name === "string" && entry.name) {
        sessionName = entry.name;
      }
    }
  } else {
    fileCreated = false;
    sessionId = crypto.randomUUID();
  }
} else {
  sessionId = crypto.randomUUID();
  const encodedCwd = `-${process.cwd().replaceAll("/", "-")}--`;
  const fileName = `${new Date().toISOString().replace(/[:.]/g, "-")}_${sessionId}.jsonl`;
  sessionFile = path.join(sessionDirArg, encodedCwd, fileName);
  fileCreated = false;
}

// ── Helpers ───────────────────────────────────────────────────────────────

function newEntryId() {
  return crypto.randomBytes(4).toString("hex");
}

function appendEntry(fields) {
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

function ensureFile() {
  if (fileCreated) return;
  fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
  const header = {
    type: "session",
    version: 3,
    id: sessionId,
    timestamp: new Date().toISOString(),
    cwd: process.cwd(),
  };
  fs.writeFileSync(sessionFile, `${JSON.stringify(header)}\n`);
  fileCreated = true;
  if (pendingName !== null) {
    appendEntry({ type: "session_info", name: pendingName });
    pendingName = null;
  }
}

function send(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Behaviors (preserved reply texts from the original) ──────────────────

async function handleHello(id) {
  send({ type: "agent_start" });
  send({ type: "turn_start" });
  send({ type: "message_start", message: { role: "assistant" } });

  const deltas = ["Hello! ", "I'm ", "your pi ", "coding agent."];
  for (const delta of deltas) {
    send({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: { type: "text_delta", delta },
    });
    await sleep(50);
  }

  send({ type: "message_end", message: { role: "assistant" } });
  send({ type: "turn_end" });
  send({ type: "agent_end" });
  send({ type: "response", command: "prompt", success: true, id });
}

async function handleUseTool(id) {
  send({ type: "agent_start" });
  send({ type: "turn_start" });
  send({
    type: "tool_execution_start",
    toolCallId: "tool-1",
    toolName: "read_file",
    args: { path: "test.txt" },
  });

  await sleep(100);
  send({
    type: "tool_execution_update",
    toolCallId: "tool-1",
    toolName: "read_file",
    args: { path: "test.txt" },
    partialResult: "reading...\n",
  });
  await sleep(100);
  send({
    type: "tool_execution_end",
    toolCallId: "tool-1",
    toolName: "read_file",
    result: "file contents here",
    isError: false,
  });

  send({ type: "message_start", message: { role: "assistant" } });
  send({
    type: "message_update",
    message: { role: "assistant" },
    assistantMessageEvent: { type: "text_delta", delta: "Done reading." },
  });
  send({ type: "message_end", message: { role: "assistant" } });
  send({ type: "turn_end" });
  send({ type: "agent_end" });
  send({ type: "response", command: "prompt", success: true, id });
}

async function handleLongTool(id) {
  const output = Array.from({ length: 240 }, (_, i) => {
    const n = String(i + 1).padStart(3, "0");
    return `long-tool-line-${n}  ${"abcdef0123456789 ".repeat((i % 8) + 1)}complete`;
  }).join("\n");
  const command = `node scripts/generate-long-report.mjs --workspace ${process.cwd()} --include-transcript --format=json --long-option=${"value-".repeat(22)}tail`;

  send({ type: "agent_start" });
  send({ type: "turn_start" });
  send({
    type: "tool_execution_start",
    toolCallId: "tool-long-output",
    toolName: "bash",
    args: { command },
  });
  await sleep(50);
  send({
    type: "tool_execution_update",
    toolCallId: "tool-long-output",
    toolName: "bash",
    args: { command },
    partialResult: {
      content: [{ type: "text", text: output.split("\n").slice(0, 80).join("\n") }],
      details: { truncation: { truncated: false } },
    },
  });
  await sleep(50);
  send({
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
  send({ type: "message_start", message: { role: "assistant" } });
  send({
    type: "message_update",
    message: { role: "assistant" },
    assistantMessageEvent: { type: "text_delta", delta: "Long tool output captured." },
  });
  send({ type: "message_end", message: { role: "assistant" } });
  send({ type: "turn_end" });
  send({ type: "agent_end" });
  send({ type: "response", command: "prompt", success: true, id });
}

const uiPending = new Map();

async function handleAskMe(id) {
  send({ type: "response", command: "prompt", success: true, id });
  send({ type: "agent_start" });

  const reqId = "ui-req-1";
  send({
    type: "extension_ui_request",
    id: reqId,
    method: "select",
    title: "Pick an option",
    options: ["Option A", "Option B", "Option C"],
  });

  uiPending.set(reqId, async (response) => {
    const chosen = response.value ?? "(cancelled)";
    send({ type: "message_start", message: { role: "assistant" } });
    send({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: { type: "text_delta", delta: `You chose: ${chosen}` },
    });
    send({ type: "message_end", message: { role: "assistant" } });
    send({ type: "turn_end" });
    send({ type: "agent_end" });
  });
}

// Helper used by handlers to chunk a string into fixed-size pieces for
// the message_update text_delta stream. Tests stream fake agent output
// this way to exercise the renderer's streaming reducer.
function chunks(text, size) {
  const out = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

async function handleEcho(id, message) {
  send({ type: "agent_start" });
  send({ type: "message_start", message: { role: "assistant" } });
  send({
    type: "message_update",
    message: { role: "assistant" },
    assistantMessageEvent: { type: "text_delta", delta: `Echo: ${message}` },
  });
  send({ type: "message_end", message: { role: "assistant" } });
  send({ type: "agent_end" });
  send({ type: "response", command: "prompt", success: true, id });
}

// ── Main loop ─────────────────────────────────────────────────────────────

const rl = createInterface({ input: process.stdin, terminal: false });

rl.on("line", async (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }

  const { type, id } = msg;

  if (type === "extension_ui_response") {
    const handler = uiPending.get(msg.id);
    if (handler) {
      uiPending.delete(msg.id);
      await handler(msg);
    }
    return;
  }

  switch (type) {
    case "prompt": {
      // App sends `message`; keep `content` for back-compat with old tests.
      const text = String(msg.message ?? msg.content ?? "");
      const lowered = text.toLowerCase();

      // Persist the user turn BEFORE dispatching.
      ensureFile();
      const userEntryId = appendEntry({
        type: "message",
        message: {
          role: "user",
          content: [{ type: "text", text }],
          timestamp: Date.now(),
        },
      });
      // Real pi emits message_start/message_end for the delivered prompt
      // with role: "user". Fake-pi used to skip this, masking bugs in
      // the renderer's echo dedupe (e.g. the optimistic user bubble
      // would silently duplicate). Emit both, matching real pi.
      send({ type: "message_start", message: { role: "user", content: [{ type: "text", text }] } });
      send({ type: "message_end", message: { role: "user", content: [{ type: "text", text }] } });
      userMessagesForForking.push({ entryId: userEntryId, text });

      if (lowered === "/ask-user-question" || lowered.startsWith("/ask-user-question ")) {
        // Emit a select dialog and ONLY respond after the renderer
        // answers — this mirrors real pi's preflight timing so the
        // renderer's RPC timeout policy gets exercised.
        const questionId = crypto.randomUUID();
        const resolver = (answer) => {
          send({ type: "response", command: "prompt", success: true, id });
          // Echo a custom message with the chosen answer so the test
          // can verify the round trip.
          const replyText = `ask-user-question chose: ${answer}`;
          send({ type: "message_start", message: { role: "assistant" } });
          for (const chunk of chunks(replyText, 12)) {
            send({
              type: "message_update",
              message: { role: "assistant" },
              assistantMessageEvent: { type: "text_delta", delta: chunk },
            });
          }
          send({ type: "message_end", message: { role: "assistant" } });
        };
        uiPending.set(questionId, async (response) => {
          const v = response && response.value !== undefined ? response.value : "no-answer";
          resolver(v);
        });
        send({
          type: "extension_ui_request",
          id: questionId,
          method: "select",
          title: "Pick a choice",
          options: ["Allow", "Deny", "Ask me later"],
          timeout: 120000,
        });
        break;
      }

      if (lowered === "/set-editor" || lowered.startsWith("/set-editor ")) {
        // Fire-and-forget set_editor_text request.
        const textId = crypto.randomUUID();
        send({
          type: "extension_ui_request",
          id: textId,
          method: "set_editor_text",
          text: "injected by extension",
        });
        // Send a minimal response so the prompt RPC completes.
        send({ type: "response", command: "prompt", success: true, id });
        // Emit a follow-up text delta so the test sees a turn.
        const replyText = "set-editor requested";
        send({ type: "message_start", message: { role: "assistant" } });
        for (const chunk of chunks(replyText, 12)) {
          send({
            type: "message_update",
            message: { role: "assistant" },
            assistantMessageEvent: { type: "text_delta", delta: chunk },
          });
        }
        send({ type: "message_end", message: { role: "assistant" } });
        break;
      }

      if (lowered === "/timeout-select" || lowered.startsWith("/timeout-select ")) {
        // Select with a 1.5s timeout. The renderer should auto-dismiss
        // locally and NOT send a response (the seconds-bug regression
        // held the dialog open for 1500s by multiplying ms by 1000).
        const tid = crypto.randomUUID();
        uiPending.set(tid, async () => {
          // The dialog should have auto-resolved; we don't echo anything
          // so the renderer must not block on this.
        });
        send({
          type: "extension_ui_request",
          id: tid,
          method: "select",
          title: "Auto-dismiss me",
          options: ["yes", "no"],
          timeout: 1500,
        });
        // Complete the prompt so the renderer can issue the next test step.
        send({ type: "response", command: "prompt", success: true, id });
        break;
      }

      if (lowered === "/widget-on" || lowered.startsWith("/widget-on ")) {
        // Mirrors the /plan extension's enter flow: setWidget + setStatus
        // fire-and-forget, then a normal assistant turn. The fields are
        // present on the wire so the renderer populates the widget strip
        // and the status segment.
        send({
          type: "extension_ui_request",
          id: crypto.randomUUID(),
          method: "setWidget",
          widgetKey: "plan",
          widgetLines: [
            "Plan mode: planning",
            "Tools: read_file",
            "Produce a <proposed_plan> block.",
          ],
        });
        send({
          type: "extension_ui_request",
          id: crypto.randomUUID(),
          method: "setStatus",
          statusKey: "plan",
          statusText: "plan active",
        });
        // Then a normal assistant turn so the test can also assert the
        // transcript keeps going.
        await handleEcho(id, text);
        appendEntry({
          type: "message",
          message: {
            role: "assistant",
            content: [{ type: "text", text: `Echo: ${text}` }],
            timestamp: Date.now(),
          },
        });
        break;
      }

      if (lowered === "/widget-off" || lowered.startsWith("/widget-off ")) {
        // Mirrors the /plan extension's exit flow: setWidget + setStatus
        // with their payload fields set to `undefined`. `JSON.stringify`
        // drops undefined values, so the wire frame omits them entirely —
        // exactly how real pi clears UI. The schema and the store must
        // both handle this shape.
        send({
          type: "extension_ui_request",
          id: crypto.randomUUID(),
          method: "setWidget",
          widgetKey: "plan",
          widgetLines: undefined,
        });
        send({
          type: "extension_ui_request",
          id: crypto.randomUUID(),
          method: "setStatus",
          statusKey: "plan",
          statusText: undefined,
        });
        await handleEcho(id, text);
        appendEntry({
          type: "message",
          message: {
            role: "assistant",
            content: [{ type: "text", text: `Echo: ${text}` }],
            timestamp: Date.now(),
          },
        });
        break;
      }

      if (lowered.includes("hello")) {
        await handleHello(id);
        appendEntry({
          type: "message",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Hello! I'm your pi coding agent." }],
            timestamp: Date.now(),
          },
        });
        lastAssistantText = "Hello! I'm your pi coding agent.";
      } else if (lowered.includes("long-tool")) {
        await handleLongTool(id);
        appendEntry({
          type: "message",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Long tool output captured." }],
            timestamp: Date.now(),
          },
        });
        lastAssistantText = "Long tool output captured.";
      } else if (lowered.includes("use-tool")) {
        await handleUseTool(id);
        appendEntry({
          type: "message",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Done reading." }],
            timestamp: Date.now(),
          },
        });
        lastAssistantText = "Done reading.";
      } else if (lowered.includes("ask-me")) {
        // ask-me path persists only the user entry; unused by the restore e2e.
        await handleAskMe(id);
      } else {
        await handleEcho(id, text);
        appendEntry({
          type: "message",
          message: {
            role: "assistant",
            content: [{ type: "text", text: `Echo: ${text}` }],
            timestamp: Date.now(),
          },
        });
        lastAssistantText = `Echo: ${text}`;
      }
      break;
    }

    case "get_commands":
      send({
        type: "response",
        command: "get_commands",
        success: true,
        id,
        data: {
          commands: [
            { name: "login", description: "Login to a provider" },
            { name: "model", description: "Switch model" },
            { name: "compact", description: "Compact context" },
            // Test extensions — names must match what the prompt handler
            // checks for. `sourceInfo` is the v0.79.1 wire shape.
            {
              name: "ask-user-question",
              description: "Ask the user a question (test extension)",
              source: "extension",
              sourceInfo: { path: "/fake/extensions/ask-user-question.js", scope: "user" },
            },
            {
              name: "set-editor",
              description: "Inject text into the editor (test extension)",
              source: "extension",
              sourceInfo: { path: "/fake/extensions/set-editor.js", scope: "user" },
            },
            {
              name: "timeout-select",
              description: "Open a select dialog with a 1.5s timeout (test extension)",
              source: "extension",
              sourceInfo: { path: "/fake/extensions/timeout-select.js", scope: "user" },
            },
            {
              name: "skill:brave-search",
              description: "Web search via Brave API",
              source: "skill",
            },
            { name: "fix-tests", description: "Fix failing tests", source: "prompt" },
          ],
        },
      });
      break;

    case "get_state":
      send({
        type: "response",
        command: "get_state",
        success: true,
        id,
        data: {
          model: currentModel(),
          thinkingLevel: currentThinkingLevel,
          isStreaming: false,
          isCompacting: false,
          sessionFile,
          sessionId,
          ...(sessionName ? { sessionName } : {}),
          messageCount: 0,
        },
      });
      break;

    case "get_session_stats":
      send({
        type: "response",
        command: "get_session_stats",
        success: true,
        id,
        data: {
          sessionFile,
          sessionId,
          userMessages: 0,
          assistantMessages: 0,
          toolCalls: 0,
          toolResults: 0,
          totalMessages: 0,
          tokens: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, total: 150 },
          cost: 0.001,
          contextUsage: { tokens: 150, contextWindow: 200000, percent: 0.075 },
        },
      });
      break;

    case "get_available_models":
      send({
        type: "response",
        command: "get_available_models",
        success: true,
        id,
        data: {
          models: fakeModels,
          currentModelId,
        },
      });
      break;

    case "set_model":
      currentModelId = msg.modelId ?? currentModelId;
      send({ type: "response", command: "set_model", success: true, id });
      break;

    case "set_thinking_level":
      currentThinkingLevel = msg.level;
      send({ type: "response", command: "set_thinking_level", success: true, id });
      send({ type: "thinking_level_changed", level: msg.level });
      break;

    case "set_session_name": {
      // 1. Persist before responding so the renderer's post-response refresh sees the write.
      if (fileCreated) {
        appendEntry({ type: "session_info", name: msg.name });
      } else {
        pendingName = msg.name;
      }
      sessionName = msg.name;
      // 2. Ack.
      send({ type: "response", command: "set_session_name", success: true, id });
      // 3. Notify subscribers.
      send({ type: "session_info_changed", name: msg.name });
      break;
    }

    case "abort":
      send({ type: "agent_end" });
      send({ type: "response", command: "abort", success: true, id });
      break;

    case "bash":
      send({
        type: "response",
        command: "bash",
        success: true,
        id,
        data: { output: `$ ${msg.command}\nbash output here\n` },
      });
      break;

    case "new_session":
      // TUI parity: respond with `cancelled: false` (i.e. session changed),
      // then the renderer will follow up with get_state which we serve
      // above. For the new session we mint a fresh sessionId + file so
      // the renderer can adopt a different path. This is what makes the
      // fileChanged flow meaningful.
      newSessionCancelled = false;
      {
        // Allocate a fresh file under the encoded-cwd subdir.
        const cwd = process.cwd();
        const enc = Buffer.from(cwd).toString("hex");
        const dir = path.join(process.env.FAKE_PI_SESSIONS_DIR ?? "/tmp", enc);
        fs.mkdirSync(dir, { recursive: true });
        const newFile = path.join(dir, `new-${Date.now()}.jsonl`);
        sessionFile = newFile;
        sessionId = `ses-${crypto.randomUUID()}`;
        sessionName = null;
        lastEntryId = null;
        fileCreated = true;
        userMessagesForForking = [];
        lastAssistantText = null;
        isCompacting = false;
        // Write a header so subsequent get_session_stats doesn't choke.
        fs.writeFileSync(
          newFile,
          `${JSON.stringify({
            type: "header",
            version: 1,
            id: sessionId,
            timestamp: Date.now(),
            cwd,
            parentSession: msg.parentSession ?? null,
          })}\n`,
        );
        send({
          type: "response",
          command: "new_session",
          success: true,
          id,
          data: { cancelled: false },
        });
        send({ type: "session_info_changed", name: undefined });
      }
      break;

    case "switch_session":
      // Tests configure switchSessionCancelled up-front to simulate a
      // refused switch (e.g. an "are you sure?" prompt the user
      // declined). Otherwise the operation succeeds and the renderer
      // will get_state to learn the file.
      if (switchSessionCancelled) {
        send({
          type: "response",
          command: "switch_session",
          success: true,
          id,
          data: { cancelled: true },
        });
        switchSessionCancelled = false;
      } else {
        sessionFile = msg.sessionPath;
        sessionId = `ses-${crypto.randomUUID()}`;
        lastEntryId = null;
        fileCreated = true;
        userMessagesForForking = [];
        lastAssistantText = null;
        send({
          type: "response",
          command: "switch_session",
          success: true,
          id,
          data: { cancelled: false },
        });
      }
      break;

    case "fork": {
      // Find the message and produce a new file with the entry chain
      // truncated at entryId. TUI returns `{ text, cancelled: false }`
      // where `text` is the text the editor will be prefilled with.
      const forkMessage = userMessagesForForking.find((m) => m.entryId === msg.entryId);
      if (!forkMessage) {
        send({
          type: "response",
          command: "fork",
          success: false,
          id,
          error: "Fork point not found",
        });
        break;
      }
      const cwd = process.cwd();
      const enc = Buffer.from(cwd).toString("hex");
      const dir = path.join(process.env.FAKE_PI_SESSIONS_DIR ?? "/tmp", enc);
      fs.mkdirSync(dir, { recursive: true });
      const newFile = path.join(dir, `fork-${Date.now()}.jsonl`);
      const newId = `ses-${crypto.randomUUID()}`;
      // Truncate the source file at the entry before the fork point
      // and write a header for the new session.
      if (sessionFile && fs.existsSync(sessionFile)) {
        const lines = fs
          .readFileSync(sessionFile, "utf8")
          .split("\n")
          .filter((l) => l.trim().length > 0);
        const headerLine = lines[0];
        const truncateIdx = lines.findIndex((l) => {
          try {
            return JSON.parse(l).id === msg.entryId;
          } catch {
            return false;
          }
        });
        const kept = truncateIdx > 0 ? lines.slice(0, truncateIdx) : headerLine ? [headerLine] : [];
        fs.writeFileSync(newFile, `${kept.join("\n")}\n`);
      } else {
        fs.writeFileSync(
          newFile,
          `${JSON.stringify({
            type: "header",
            version: 1,
            id: newId,
            timestamp: Date.now(),
            cwd,
          })}\n`,
        );
      }
      // Save the new file so the next get_state reflects it.
      sessionFile = newFile;
      sessionId = newId;
      forkResolution = { file: newFile, text: forkMessage.text };
      send({
        type: "response",
        command: "fork",
        success: true,
        id,
        data: { text: forkMessage.text, cancelled: false },
      });
      break;
    }

    case "clone": {
      if (!sessionFile) {
        send({ type: "response", command: "clone", success: false, id, error: "Nothing to clone" });
        break;
      }
      const cwd = process.cwd();
      const enc = Buffer.from(cwd).toString("hex");
      const dir = path.join(process.env.FAKE_PI_SESSIONS_DIR ?? "/tmp", enc);
      fs.mkdirSync(dir, { recursive: true });
      const newFile = path.join(dir, `clone-${Date.now()}.jsonl`);
      fs.copyFileSync(sessionFile, newFile);
      sessionFile = newFile;
      send({ type: "response", command: "clone", success: true, id, data: { cancelled: false } });
      break;
    }

    case "get_fork_messages":
      send({
        type: "response",
        command: "get_fork_messages",
        success: true,
        id,
        data: {
          messages: userMessagesForForking.map((m) => ({ entryId: m.entryId, text: m.text })),
        },
      });
      break;

    case "get_last_assistant_text":
      send({
        type: "response",
        command: "get_last_assistant_text",
        success: true,
        id,
        data: { text: lastAssistantText },
      });
      break;

    case "get_messages":
      send({
        type: "response",
        command: "get_messages",
        success: true,
        id,
        data: { messages: [] },
      });
      break;

    case "compact":
      // Emit a compaction_start, run a tiny "compaction" delay, then a
      // compaction_end with a summary, and finally the response. The
      // renderer needs the response to land (which it does, after the
      // events) and a 0 RPC timeout is now in place so we don't have
      // a window for a spurious rejection.
      isCompacting = true;
      send({ type: "compaction_start", reason: "manual" });
      setTimeout(() => {
        isCompacting = false;
        const summary = `Compacted ${userMessagesForForking.length} messages`;
        send({ type: "compaction_end", summary, tokensBefore: 1000, tokensAfter: 200 });
        send({
          type: "response",
          command: "compact",
          success: true,
          id,
          data: { summary, cancelled: false, tokensBefore: 1000, tokensAfter: 200 },
        });
      }, 80);
      break;

    case "export_html":
      // Write a tiny HTML file to the configured output path and report
      // the path. Tests can read it back to verify.
      {
        const exportPath =
          msg.outputPath ||
          path.join(process.env.FAKE_PI_SESSIONS_DIR ?? "/tmp", `export-${Date.now()}.html`);
        fs.writeFileSync(exportPath, "<html><body>exported</body></html>");
        send({
          type: "response",
          command: "export_html",
          success: true,
          id,
          data: { path: exportPath },
        });
      }
      break;

    default:
      send({
        type: "response",
        command: type ?? "unknown",
        success: false,
        id,
        error: `Unknown command: ${type}`,
      });
  }
});

process.stdin.resume();
