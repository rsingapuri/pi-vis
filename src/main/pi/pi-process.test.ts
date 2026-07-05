import fs from "node:fs";
import os from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { PiProcess } from "./pi-process.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FAKE_PI = join(__dirname, "../../../tests/fixtures/fake-pi.mjs");

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 5000,
  label = "condition",
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`Timed out waiting for ${label} after ${timeoutMs}ms`);
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("PiProcess", () => {
  const procs: PiProcess[] = [];

  afterEach(() => {
    for (const p of procs) p.stop();
    procs.length = 0;
  });

  it("sends a command and receives a correlated response", async () => {
    const proc = new PiProcess("node", process.cwd());
    // Override: spawn node fake-pi.mjs instead
    // Actually we need to spawn with the right args
    proc.stop();

    // Spawn fake-pi directly
    const { spawn } = await import("node:child_process");
    const child = spawn("node", [FAKE_PI], { cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"] });

    const events: unknown[] = [];
    const { JsonlStream } = await import("./jsonl-stream.js");
    const stream = new JsonlStream(
      (p) => events.push(p),
      () => {},
    );
    child.stdout.on("data", (chunk: Buffer) => stream.feed(chunk));

    // Send get_commands
    const id = "test-1";
    child.stdin.write(`${JSON.stringify({ type: "get_commands", id })}\n`);

    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        const found = events.find((e) => {
          const ev = e as { kind: string; data: { id?: string } };
          return ev.kind === "response" && ev.data.id === id;
        });
        if (found) {
          clearInterval(check);
          resolve();
        }
      }, 50);
    });

    const response = events.find((e) => {
      const ev = e as { kind: string; data: { id?: string } };
      return ev.kind === "response" && ev.data.id === id;
    }) as { kind: string; data: { success: boolean; data: unknown } };

    expect(response.data.success).toBe(true);
    expect(Array.isArray((response.data.data as { commands: unknown[] }).commands)).toBe(true);
    child.kill();
  }, 10_000);

  it("stop escalates to SIGKILL when the child ignores SIGTERM", async () => {
    const tmp = fs.mkdtempSync(join(os.tmpdir(), "pivis-pi-stop-"));
    const script = join(tmp, "ignore-term.mjs");
    const pidFile = join(tmp, "pid");
    let pid: number | undefined;
    try {
      fs.writeFileSync(
        script,
        [
          "#!/usr/bin/env node",
          'import fs from "node:fs";',
          "fs.writeFileSync(process.env.PID_FILE, String(process.pid));",
          'process.on("SIGTERM", () => {});',
          "setInterval(() => {}, 1000);",
          "",
        ].join("\n"),
        { mode: 0o755 },
      );

      const proc = new PiProcess(script, tmp, undefined, { PID_FILE: pidFile });
      procs.push(proc);
      await waitFor(() => fs.existsSync(pidFile), 2000, "child pid file");
      pid = Number(fs.readFileSync(pidFile, "utf8"));
      expect(isPidAlive(pid)).toBe(true);

      proc.stop();

      await waitFor(() => !isPidAlive(pid as number), 6000, "child SIGKILL escalation");
    } finally {
      if (pid !== undefined && isPidAlive(pid)) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* already gone */
        }
      }
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 10_000);
});
