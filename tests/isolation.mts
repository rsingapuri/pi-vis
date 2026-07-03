import { createHash } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const UID = process.getuid?.() ?? "user";
const STALE_LOCK_MS = 6 * 60 * 60 * 1000;

function hashInt(input: string): number {
  return createHash("sha256").update(input).digest().readUInt32BE(0);
}

export function testScope(cwd = process.cwd()): string {
  const runId = process.env["PIVIS_TEST_RUN_ID"];
  if (runId) return safeSegment(runId);
  const realCwd = fs.realpathSync(cwd);
  return hashInt(realCwd).toString(16).padStart(8, "0");
}

export function scopedTmpPath(prefix: string, extension: string, cwd = process.cwd()): string {
  return path.join(os.tmpdir(), `${prefix}-${UID}-${testScope(cwd)}.${extension}`);
}

export function scopedPort(options: {
  envName: string;
  scopeName: string;
  base: number;
  range: number;
}): number {
  const explicit = process.env[options.envName];
  if (explicit) {
    const port = Number.parseInt(explicit, 10);
    if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
      throw new Error(`${options.envName} must be a TCP port, got ${JSON.stringify(explicit)}`);
    }
    return port;
  }

  return options.base + (hashInt(`${testScope()}:${options.scopeName}`) % options.range);
}

export async function isolatedPort(options: {
  envName: string;
  scopeName: string;
  base: number;
  range: number;
}): Promise<number> {
  const explicit = process.env[options.envName];
  if (explicit) return scopedPort(options);

  const start = scopedPort(options) - options.base;
  for (let i = 0; i < options.range; i++) {
    const port = options.base + ((start + i) % options.range);
    const lockDir = path.join(os.tmpdir(), `pivis-test-port-${UID}-${port}.lock`);
    if (!tryAcquireLock(lockDir)) continue;
    if (await canListen(port)) {
      const cleanup = () => fs.rmSync(lockDir, { recursive: true, force: true });
      process.once("exit", cleanup);
      process.once("SIGINT", () => {
        cleanup();
        process.exit(130);
      });
      process.once("SIGTERM", () => {
        cleanup();
        process.exit(143);
      });
      return port;
    }
    fs.rmSync(lockDir, { recursive: true, force: true });
  }
  throw new Error(`No free test port found for ${options.scopeName}`);
}

function tryAcquireLock(lockDir: string): boolean {
  try {
    fs.mkdirSync(lockDir);
    fs.writeFileSync(path.join(lockDir, "pid"), String(process.pid));
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "EEXIST") throw err;
    try {
      const stat = fs.statSync(lockDir);
      if (Date.now() - stat.mtimeMs > STALE_LOCK_MS) {
        fs.rmSync(lockDir, { recursive: true, force: true });
        fs.mkdirSync(lockDir);
        fs.writeFileSync(path.join(lockDir, "pid"), String(process.pid));
        return true;
      }
    } catch {
      // Race with another process cleaning up the stale lock; let the caller try another port.
    }
    return false;
  }
}

function canListen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolve(true));
    });
  });
}

function safeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 80) || "default";
}
