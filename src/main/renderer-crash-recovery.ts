export interface RendererProcessGoneDetails {
  reason: string;
  exitCode: number;
}

export interface RendererRecoveryDiagnostic extends RendererProcessGoneDetails {
  event: "render-process-gone" | "renderer-recovery-scheduled" | "renderer-recovery-terminal";
  message?: string;
}

export interface RendererCrashRecoveryOptions {
  reload: () => void;
  log: (diagnostic: RendererRecoveryDiagnostic) => void;
  onTerminal?: (diagnostic: RendererRecoveryDiagnostic) => void;
  schedule?: (callback: () => void) => void;
}

const EXPECTED_EXIT_REASONS = new Set(["clean-exit", "killed"]);
const RELOADABLE_EXIT_REASONS = new Set(["abnormal-exit", "crashed", "oom"]);

/**
 * Recovers at most once for the lifetime of a BrowserWindow.
 *
 * A renderer reload is safe after a process crash because renderer custody has
 * already been lost and the normal generation/authority attach path rebuilds
 * it. Never resetting the attempt flag is deliberate: a persistent startup or
 * focus crash must terminate visibly instead of entering a reload loop.
 */
export class RendererCrashRecovery {
  private recoveryAttempted = false;
  private terminalReported = false;
  private readonly schedule: (callback: () => void) => void;

  constructor(private readonly options: RendererCrashRecoveryOptions) {
    this.schedule = options.schedule ?? ((callback) => setTimeout(callback, 0));
  }

  handle(details: RendererProcessGoneDetails): void {
    this.log({ event: "render-process-gone", ...details });

    if (EXPECTED_EXIT_REASONS.has(details.reason)) return;

    if (!RELOADABLE_EXIT_REASONS.has(details.reason)) {
      this.reportTerminal(
        details,
        `Renderer exited with non-recoverable reason: ${details.reason}`,
      );
      return;
    }

    if (this.recoveryAttempted) {
      this.reportTerminal(details, "Renderer crashed again after its one automatic recovery");
      return;
    }

    this.recoveryAttempted = true;
    this.log({ event: "renderer-recovery-scheduled", ...details });
    this.schedule(() => {
      try {
        this.options.reload();
      } catch (error) {
        this.reportTerminal(
          details,
          `Renderer reload failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    });
  }

  private reportTerminal(details: RendererProcessGoneDetails, message: string): void {
    if (this.terminalReported) return;
    this.terminalReported = true;
    const diagnostic: RendererRecoveryDiagnostic = {
      event: "renderer-recovery-terminal",
      ...details,
      message,
    };
    this.log(diagnostic);
    try {
      this.options.onTerminal?.(diagnostic);
    } catch {
      // A native-dialog failure must not become a second main-process failure.
    }
  }

  private log(diagnostic: RendererRecoveryDiagnostic): void {
    try {
      this.options.log(diagnostic);
    } catch {
      // Crash diagnostics are best effort and must never destabilize main.
    }
  }
}
