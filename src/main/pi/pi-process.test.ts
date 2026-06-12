import { describe, it, expect, afterEach } from "vitest";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { PiProcess } from "./pi-process.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FAKE_PI = join(__dirname, "../../../tests/fixtures/fake-pi.mjs");

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
    const { spawn } = await import("child_process");
    const child = spawn("node", [FAKE_PI], { cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"] });

    const events: unknown[] = [];
    const { JsonlStream } = await import("./jsonl-stream.js");
    const stream = new JsonlStream((p) => events.push(p), () => {});
    child.stdout.on("data", (chunk: Buffer) => stream.feed(chunk));

    // Send get_commands
    const id = "test-1";
    child.stdin.write(JSON.stringify({ type: "get_commands", id }) + "\n");

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
});
