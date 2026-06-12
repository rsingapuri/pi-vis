import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { spawn, type ChildProcess } from "child_process";
import fs from "fs";
import os from "os";
import { JsonlStream, type PiOutbound } from "./jsonl-stream.js";
import { SessionHeaderSchema } from "@shared/session-file/entries.js";
import { SessionStateSchema, SessionStatsSchema } from "@shared/pi-protocol/responses.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FAKE_PI = join(__dirname, "../../../tests/fixtures/fake-pi.mjs");

/** Spawn fake-pi with stdin/stdout piped. Returns a harness that buffers parsed outbound lines. */
function startFakePi(args: string[], cwd: string, env: Record<string, string>) {
  const child: ChildProcess = spawn("node", [FAKE_PI, ...args], {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env,
  });
  const out: PiOutbound[] = [];
  const stream = new JsonlStream(
    (p) => out.push(p),
    (err) => {
      throw err;
    },
  );
  child.stdout?.on("data", (chunk: Buffer) => stream.feed(chunk));
  return { child, out };
}

/** Wait until predicate returns truthy, polling every 25ms. */
async function waitFor(predicate: () => boolean, timeoutMs = 5000, label = "condition"): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`Timed out waiting for ${label} after ${timeoutMs}ms`);
}

/** Send a command and return the matching response payload. */
function sendCommand(
  child: ChildProcess,
  out: PiOutbound[],
  command: Record<string, unknown>,
  timeoutMs = 5000,
): Promise<{ id?: string; success: boolean; data?: unknown }> {
  const id = command.id as string | undefined;
  child.stdin?.write(JSON.stringify(command) + "\n");
  return waitFor(() => out.some((e) => e.kind === "response" && e.data.id === id), timeoutMs, `response to ${command.type}`).then(
    () => {
      const response = out.find((e) => e.kind === "response" && e.data.id === id) as
        | { kind: "response"; data: { id?: string; success: boolean; data?: unknown } }
        | undefined;
      if (!response) throw new Error("response disappeared");
      return response.data;
    },
  );
}

describe("fake-pi fixture", () => {
  let sessionsDir: string;
  let workspaceDir: string;

  beforeAll(() => {
    fs.chmodSync(FAKE_PI, 0o755);
  });

  beforeEach(() => {
    sessionsDir = fs.mkdtempSync(join(os.tmpdir(), "fake-pi-test-sessions-"));
    workspaceDir = fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(), "fake-pi-test-ws-")));
    process.env.FAKE_PI_SESSIONS_DIR = sessionsDir;
  });

  afterEach(() => {
    delete process.env.FAKE_PI_SESSIONS_DIR;
    try {
      fs.rmSync(sessionsDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
    try {
      fs.rmSync(workspaceDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  it("--version prints fake-pi version and exits 0", async () => {
    const child = spawn("node", [FAKE_PI, "--version"], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    const exitCode: number = await new Promise((resolve) => child.on("exit", (code) => resolve(code ?? -1)));
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/^fake-pi /);
  });

  it("persists session file with user/assistant entries on first prompt", async () => {
    const { child, out } = startFakePi([], workspaceDir, { ...process.env, FAKE_PI_SESSIONS_DIR: sessionsDir });

    const response = await sendCommand(child, out, { type: "prompt", message: "say hi", id: "p1" });
    expect(response.success).toBe(true);

    // Exactly one .jsonl file should exist under the encoded-cwd subdir.
    const subdirs = fs.readdirSync(sessionsDir);
    expect(subdirs.length).toBe(1);
    const encodedCwd = subdirs[0]!;
    const files = fs.readdirSync(join(sessionsDir, encodedCwd));
    expect(files.length).toBe(1);
    const filePath = join(sessionsDir, encodedCwd, files[0]!);

    const content = fs.readFileSync(filePath, "utf8");
    const lines = content.split("\n").filter((l) => l.trim().length > 0);
    expect(lines.length).toBeGreaterThanOrEqual(3);

    // Line 1 = header; must parse against SessionHeaderSchema and cwd matches the spawn cwd.
    const header = JSON.parse(lines[0]!);
    const headerParse = SessionHeaderSchema.safeParse(header);
    expect(headerParse.success).toBe(true);
    expect(header.cwd).toBe(workspaceDir);

    // Remaining lines = entries; user message + assistant message; parentId chains through.
    const entries = lines.slice(1).map((l) => JSON.parse(l));
    const userEntry = entries.find((e) => e.type === "message" && e.role === "user");
    expect(userEntry).toBeDefined();
    expect(userEntry.content[0].text).toBe("say hi");

    const assistantEntry = entries.find((e) => e.type === "message" && e.role === "assistant");
    expect(assistantEntry).toBeDefined();
    expect(assistantEntry.content[0].text).toMatch(/^Echo: say hi$/);

    // Every entry after the first must have a parentId equal to the previous entry's id.
    for (let i = 1; i < entries.length; i++) {
      expect(entries[i].parentId).toBe(entries[i - 1].id);
    }

    child.kill();
  }, 15_000);

  it("set_session_name appends a session_info entry and emits session_info_changed", async () => {
    const { child, out } = startFakePi([], workspaceDir, { ...process.env, FAKE_PI_SESSIONS_DIR: sessionsDir });

    // First create the file via a prompt.
    await sendCommand(child, out, { type: "prompt", message: "hi", id: "p1" });

    // Now rename.
    const response = await sendCommand(child, out, { type: "set_session_name", name: "My Session", id: "r1" });
    expect(response.success).toBe(true);

    // The session_info_changed event must arrive.
    const event = await waitFor(
      () => out.some((e) => e.kind === "event" && e.data.type === "session_info_changed"),
      5000,
      "session_info_changed event",
    ).then(() => out.find((e) => e.kind === "event" && e.data.type === "session_info_changed") as PiOutbound);
    expect(event).toBeDefined();
    if (event.kind === "event") {
      expect((event.data as { name: string }).name).toBe("My Session");
    }

    // Last line of the session file should be a session_info entry with that name.
    const subdirs = fs.readdirSync(sessionsDir);
    const subdir = subdirs[0]!;
    const filePath = join(sessionsDir, subdir, fs.readdirSync(join(sessionsDir, subdir))[0]!);
    const lines = fs.readFileSync(filePath, "utf8").split("\n").filter((l) => l.trim().length > 0);
    const lastEntry = JSON.parse(lines[lines.length - 1]!);
    expect(lastEntry.type).toBe("session_info");
    expect(lastEntry.name).toBe("My Session");

    child.kill();
  }, 15_000);

  it("get_state returns a SessionState with sessionName + sessionFile", async () => {
    const { child, out } = startFakePi([], workspaceDir, { ...process.env, FAKE_PI_SESSIONS_DIR: sessionsDir });

    await sendCommand(child, out, { type: "prompt", message: "hi", id: "p1" });
    await sendCommand(child, out, { type: "set_session_name", name: "My Session", id: "r1" });

    const response = await sendCommand(child, out, { type: "get_state", id: "s1" });
    expect(response.success).toBe(true);

    const data = response.data as { sessionName: string; sessionFile: string };
    const parsed = SessionStateSchema.safeParse(data);
    expect(parsed.success).toBe(true);
    expect(data.sessionName).toBe("My Session");
    expect(typeof data.sessionFile).toBe("string");
    expect(fs.existsSync(data.sessionFile)).toBe(true);

    child.kill();
  }, 15_000);

  it("get_session_stats returns valid SessionStats with sessionFile", async () => {
    const { child, out } = startFakePi([], workspaceDir, { ...process.env, FAKE_PI_SESSIONS_DIR: sessionsDir });

    const response = await sendCommand(child, out, { type: "get_session_stats", id: "st1" });
    expect(response.success).toBe(true);

    const data = response.data as { sessionFile?: string };
    const parsed = SessionStatsSchema.safeParse(data);
    expect(parsed.success).toBe(true);
    expect(typeof data.sessionFile).toBe("string");

    child.kill();
  }, 15_000);

  it("resume via --session reuses the same sessionId and sessionName", async () => {
    // First process: prompt + rename.
    const first = startFakePi([], workspaceDir, { ...process.env, FAKE_PI_SESSIONS_DIR: sessionsDir });
    await sendCommand(first.child, first.out, { type: "prompt", message: "hi", id: "p1" });
    await sendCommand(first.child, first.out, { type: "set_session_name", name: "Resumed Name", id: "r1" });

    const firstState = await sendCommand(first.child, first.out, { type: "get_state", id: "s1" });
    const firstData = firstState.data as { sessionFile: string; sessionId: string };
    const sessionFile = firstData.sessionFile;
    const firstId = firstData.sessionId;
    first.child.kill();

    // Second process: resume by passing the file path.
    const second = startFakePi(
      ["--mode", "rpc", "--session", sessionFile],
      workspaceDir,
      { ...process.env, FAKE_PI_SESSIONS_DIR: sessionsDir },
    );
    const resumedState = await sendCommand(second.child, second.out, { type: "get_state", id: "s2" });
    const resumedData = resumedState.data as { sessionId: string; sessionName?: string };
    expect(resumedData.sessionId).toBe(firstId);
    expect(resumedData.sessionName).toBe("Resumed Name");
    second.child.kill();
  }, 15_000);
});
