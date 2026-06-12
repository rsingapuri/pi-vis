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

import { createInterface } from "readline";
import fs from "fs";
import path from "path";
import os from "os";
import crypto from "crypto";

// ── CLI args ──────────────────────────────────────────────────────────────

if (process.argv.includes("--version")) {
  process.stdout.write("fake-pi 1.0.0\n");
  process.exit(0);
}

function argValue(flag) {
  const idx = process.argv.indexOf(flag);
  if (idx === -1 || idx === process.argv.length - 1) return undefined;
  return process.argv[idx + 1];
}

const sessionFileArg = argValue("--session");
const sessionDirArg =
  argValue("--session-dir") ?? process.env.FAKE_PI_SESSIONS_DIR ?? path.join(os.tmpdir(), "fake-pi-sessions");

// ── Module state ──────────────────────────────────────────────────────────

let sessionId;
let sessionFile;
let sessionName = null;
let pendingName = null;
let lastEntryId = null;
let fileCreated = false;
let currentThinkingLevel = "off";

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
  const encodedCwd = "-" + process.cwd().replaceAll("/", "-") + "--";
  const fileName = new Date().toISOString().replace(/[:.]/g, "-") + "_" + sessionId + ".jsonl";
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
  fs.appendFileSync(sessionFile, JSON.stringify(entry) + "\n");
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
  fs.writeFileSync(sessionFile, JSON.stringify(header) + "\n");
  fileCreated = true;
  if (pendingName !== null) {
    appendEntry({ type: "session_info", name: pendingName });
    pendingName = null;
  }
}

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
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
      appendEntry({
        type: "message",
        role: "user",
        content: [{ type: "text", text }],
        display: true,
      });

      if (lowered.includes("hello")) {
        await handleHello(id);
        appendEntry({
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "Hello! I'm your pi coding agent." }],
        });
      } else if (lowered.includes("use-tool")) {
        await handleUseTool(id);
        appendEntry({
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "Done reading." }],
        });
      } else if (lowered.includes("ask-me")) {
        // ask-me path persists only the user entry; unused by the restore e2e.
        await handleAskMe(id);
      } else {
        await handleEcho(id, text);
        appendEntry({
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: `Echo: ${text}` }],
        });
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
          model: {
            id: "fake-model",
            name: "Fake Model",
            api: "fake",
            provider: "fake",
            reasoning: false,
          },
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
          models: [
            { id: "fake-model", name: "Fake Model", api: "fake", provider: "fake", reasoning: false },
          ],
          currentModelId: "fake-model",
        },
      });
      break;

    case "set_model":
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
      send({ type: "response", command: "new_session", success: true, id });
      break;

    default:
      send({ type: "response", command: type ?? "unknown", success: false, id, error: `Unknown command: ${type}` });
  }
});

process.stdin.resume();
