/**
 * Embedded terminal (pty) management for pi-vis.
 *
 * Spawns a `pi` subprocess inside a pseudo-terminal for interactive
 * /login flows (OAuth/SSO). Communicates with the renderer via IPC
 * events: pty.data, pty.exit.
 *
 * Uses @homebridge/node-pty-prebuilt-multiarch for cross-platform PTY
 * support without native rebuild pain.
 */

import os from "node:os";
import { locatePi } from "./pi/locate-pi.js";
import { getLoginShellEnv } from "./auth.js";
import { getSettings } from "./settings-store.js";

// Dynamic import for node-pty — it's a native module that may not be
// installed or may fail to load. We fall back gracefully.
let ptySpawn:
  | ((
      file: string,
      args: string[],
      opts: Record<string, unknown>,
    ) => {
      onData: (cb: (data: string) => void) => { dispose(): void };
      onExit: (cb: (result: { exitCode: number }) => void) => { dispose(): void };
      write: (data: string) => void;
      resize: (cols: number, rows: number) => void;
      kill: () => void;
    })
  | null = null;

try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pty = require("node-pty");
  ptySpawn = pty.spawn.bind(pty);
} catch {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pty = require("@homebridge/node-pty-prebuilt-multiarch");
    ptySpawn = pty.spawn.bind(pty);
  } catch {
    // Neither available — pty functionality will be unavailable
  }
}

// ── Types ────────────────────────────────────────────────────────────────

type SafeSendFn = (channel: string, payload: unknown) => void;

// ── State ────────────────────────────────────────────────────────────────

const instances = new Map<string, PtyProc>();
let ptyCounter = 0;
let safeSend: SafeSendFn = () => {};

interface PtyProc {
  onData: (cb: (data: string) => void) => { dispose(): void };
  onExit: (cb: (result: { exitCode: number }) => void) => { dispose(): void };
  write: (data: string) => void;
  resize: (cols: number, rows: number) => void;
  kill: () => void;
}

// ── Init ─────────────────────────────────────────────────────────────────

export function initPty(send: SafeSendFn): void {
  safeSend = send;
}

// ── Start ────────────────────────────────────────────────────────────────

export async function startPty(opts: {
  cwd?: string;
  autoLogin?: boolean;
  cols?: number;
  rows?: number;
}): Promise<{ ptyId: string }> {
  if (!ptySpawn) {
    throw new Error(
      "PTY support is not available. Install node-pty or @homebridge/node-pty-prebuilt-multiarch.",
    );
  }

  const settings = getSettings();
  const piInfo = await locatePi(settings.piBinaryPath);
  if (!piInfo) {
    throw new Error("pi binary not found. Please install pi or set the path in settings.");
  }

  const loginShellEnv = await getLoginShellEnv();
  const env: Record<string, string> = {
    ...loginShellEnv,
    TERM: "xterm-256color",
    FORCE_COLOR: "1",
  };

  const cwd = opts.cwd ?? os.homedir();
  const cols = opts.cols ?? 80;
  const rows = opts.rows ?? 24;

  const proc = ptySpawn(piInfo.path, [], {
    name: "xterm-256color",
    cwd,
    env,
    cols,
    rows,
  });

  const ptyId = `pty-${++ptyCounter}`;
  instances.set(ptyId, proc);

  // Proxy data to renderer
  proc.onData((data: string) => {
    safeSend("pty.data", { ptyId, data });
  });

  // Proxy exit to renderer
  proc.onExit(({ exitCode }: { exitCode: number }) => {
    instances.delete(ptyId);
    safeSend("pty.exit", { ptyId, exitCode });
  });

  // If autoLogin, send /login once after a short delay so pi's editor is ready,
  // then detach this listener (node-pty's onData returns a disposable).
  if (opts.autoLogin) {
    const disposable = proc.onData(() => {
      setTimeout(() => proc.write("/login\r"), 400);
      disposable.dispose();
    });
  }

  return { ptyId };
}

// ── Write to pty ────────────────────────────────────────────────────────

export function writePty(ptyId: string, data: string): void {
  const proc = instances.get(ptyId);
  if (!proc) {
    console.warn(`writePty: unknown pty ${ptyId}`);
    return;
  }
  proc.write(data);
}

// ── Resize pty ──────────────────────────────────────────────────────────

export function resizePty(ptyId: string, cols: number, rows: number): void {
  const proc = instances.get(ptyId);
  if (!proc) {
    console.warn(`resizePty: unknown pty ${ptyId}`);
    return;
  }
  proc.resize(cols, rows);
}

// ── Kill pty ────────────────────────────────────────────────────────────

export function killPty(ptyId: string): void {
  const proc = instances.get(ptyId);
  if (!proc) {
    console.warn(`killPty: unknown pty ${ptyId}`);
    return;
  }
  try {
    proc.kill();
  } catch {
    // already dead
  }
  instances.delete(ptyId);
}

// ── Kill all (on app quit) ─────────────────────────────────────────────

export function killAllPtys(): void {
  for (const [ptyId, proc] of instances) {
    try {
      proc.kill();
    } catch {
      // already dead
    }
    instances.delete(ptyId);
  }
}

export function getPtyCount(): number {
  return instances.size;
}
