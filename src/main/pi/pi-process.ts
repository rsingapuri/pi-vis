import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { newRpcRequestId } from "@shared/ids.js";
import type { RpcRequestId } from "@shared/ids.js";
import type { PiRpcCommand } from "@shared/pi-protocol/commands.js";
import type { PiEvent } from "@shared/pi-protocol/events.js";
import type { ExtensionUiRequest } from "@shared/pi-protocol/extension-ui.js";
import type { PiRpcResponse } from "@shared/pi-protocol/responses.js";
import { JsonlStream } from "./jsonl-stream.js";

const COMMAND_TIMEOUTS_MS: Readonly<Record<string, number>> = {
  // 0 = no timer; the only termination is process exit (which `rejectAllPending`
  // handles). pi blocks on user dialogs during a `prompt` — a 30s timer
  // would fire mid-dialog and surface a spurious "RPC timeout" rejection
  // that the renderer cannot suppress. `compact` is similar: it streams
  // events as it runs and only returns when summarisation is done.
  prompt: 0,
  compact: 0,
  // Bash can take minutes; 10 minutes is the documented upper bound.
  bash: 600_000,
};

interface PendingRequest {
  resolve: (res: PiRpcResponse) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

export interface PiProcessEvents {
  event: (event: PiEvent) => void;
  uiRequest: (req: ExtensionUiRequest) => void;
  exit: (code: number | null, signal: string | null) => void;
  error: (err: Error) => void;
}

// biome-ignore lint/suspicious/noUnsafeDeclarationMerging: typed EventEmitter overloads via declaration merging
export class PiProcess extends EventEmitter {
  private proc: ChildProcess;
  private stream: JsonlStream;
  private pending = new Map<string, PendingRequest>();
  public stderrLog: string[] = [];
  public readonly sessionFile?: string | undefined;
  public exitCode: number | null = null;

  constructor(
    piPath: string,
    workspacePath: string,
    sessionFile?: string,
    env?: Record<string, string>,
  ) {
    super();
    this.sessionFile = sessionFile;
    const args = ["--mode", "rpc"];
    if (sessionFile) args.push("--session", sessionFile);

    this.proc = spawn(piPath, args, {
      cwd: workspacePath,
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.stream = new JsonlStream(
      (parsed) => {
        if (parsed.kind === "response") {
          const id = parsed.data.id;
          if (id) {
            const pending = this.pending.get(id);
            if (pending) {
              if (pending.timer) clearTimeout(pending.timer);
              this.pending.delete(id);
              pending.resolve(parsed.data);
              return;
            }
          }
          // Response with no pending request — log and ignore
          console.warn("[pi-process] unmatched response", parsed.data);
        } else if (parsed.kind === "event") {
          this.emit("event", parsed.data);
        } else if (parsed.kind === "extension_ui_request") {
          this.emit("uiRequest", parsed.data);
        } else {
          console.debug("[pi-process] unknown outbound", parsed.raw);
        }
      },
      (err) => {
        console.error("[pi-process] jsonl error", err);
      },
    );

    this.proc.stdout?.on("data", (chunk: Buffer) => {
      this.stream.feed(chunk);
    });

    this.proc.stderr?.on("data", (chunk: Buffer) => {
      const line = chunk.toString("utf8");
      this.stderrLog.push(line);
      if (this.stderrLog.length > 500) this.stderrLog.shift();
    });

    this.proc.stdout?.on("error", (err) => console.error("[pi-process] stdout error", err));
    this.proc.stderr?.on("error", (err) => console.error("[pi-process] stderr error", err));
    this.proc.stdin?.on("error", (err) => console.error("[pi-process] stdin error", err));

    this.proc.on("exit", (code: number | null, signal: NodeJS.Signals | null) => {
      this.exitCode = code;
      this.rejectAllPending(new Error(`pi process exited with code ${code}`));
      this.emit("exit", code, signal);
    });

    this.proc.on("error", (err) => {
      this.rejectAllPending(err);
      // Guard the unlistened case: the registry attaches its 'error' listener
      // only after activation completes, but a spawn failure (ENOENT on a
      // deleted pi binary) fires before that. An 'error' emission with no
      // listeners throws as an uncaughtException, which in Electron's main
      // process pops a BLOCKING native error dialog and freezes the event
      // loop. Same guard as SessionHost.emitError.
      if (this.listenerCount("error") > 0) {
        this.emit("error", err);
      } else {
        console.error("[pi-process] error (no listener):", err.message);
      }
    });
  }

  async sendCommand(
    command: PiRpcCommand,
    _options: { uiSurface?: "composer" | "unified" | undefined } = {},
  ): Promise<PiRpcResponse> {
    const id = newRpcRequestId() as string;
    const msg = `${JSON.stringify({ ...command, id })}\n`;
    // Per-command timeout. 0 = no timer; the only termination is process
    // exit, which rejectAllPending handles. A 0 timeout was previously
    // the source of the 30s "RPC timeout" false-positive during dialog
    // round-trips on `prompt` and during long `compact` runs.
    const timeoutMs = COMMAND_TIMEOUTS_MS[command.type] ?? 0;

    return new Promise((resolve, reject) => {
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              this.pending.delete(id);
              reject(
                new Error(
                  `RPC timeout for command ${command.type} (id=${id}) after ${timeoutMs}ms`,
                ),
              );
            }, timeoutMs)
          : null;

      this.pending.set(id, { resolve, reject, timer });

      if (!this.proc.stdin?.writable) {
        if (timer) clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error("pi process stdin is not writable"));
        return;
      }

      this.proc.stdin.write(msg, (err) => {
        if (err) {
          if (timer) clearTimeout(timer);
          this.pending.delete(id);
          reject(err);
        }
      });
    });
  }

  sendUiResponse(responseJson: string): void {
    if (this.proc.stdin?.writable) {
      this.proc.stdin.write(`${responseJson}\n`);
    }
  }

  private rejectAllPending(err: Error): void {
    for (const [id, pending] of this.pending) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(err);
      this.pending.delete(id);
    }
  }

  private killTimer: ReturnType<typeof setTimeout> | null = null;

  stop(): void {
    if (this.killTimer) return; // already stopping
    this.proc.kill("SIGTERM");
    this.killTimer = setTimeout(() => {
      // child.killed only means a signal was sent, not that the process exited.
      // Escalate whenever the child still has neither an exit code nor an exit
      // signal after the grace period.
      if (this.proc.exitCode === null && this.proc.signalCode === null) {
        this.proc.kill("SIGKILL");
      }
    }, 3000);
    // Don't let the escalation timer hold the app open during quit
    this.killTimer.unref?.();
    this.proc.once("exit", () => {
      if (this.killTimer) {
        clearTimeout(this.killTimer);
        this.killTimer = null;
      }
    });
  }
}

// Typed overloads for EventEmitter
export interface PiProcess {
  on(event: "event", listener: (event: PiEvent) => void): this;
  on(event: "uiRequest", listener: (req: ExtensionUiRequest) => void): this;
  on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  on(event: "error", listener: (err: Error) => void): this;
  emit(event: "event", data: PiEvent): boolean;
  emit(event: "uiRequest", data: ExtensionUiRequest): boolean;
  emit(event: "exit", code: number | null, signal: NodeJS.Signals | null): boolean;
  emit(event: "error", err: Error): boolean;
}
