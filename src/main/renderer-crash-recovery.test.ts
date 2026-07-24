import { afterEach, describe, expect, it, vi } from "vitest";
import {
  RendererCrashRecovery,
  type RendererRecoveryDiagnostic,
} from "./renderer-crash-recovery.js";

describe("RendererCrashRecovery", () => {
  afterEach(() => vi.useRealTimers());

  it("reloads once, then reports a repeated crash as terminal", async () => {
    vi.useFakeTimers();
    const reload = vi.fn();
    const log = vi.fn();
    const onTerminal = vi.fn();
    const recovery = new RendererCrashRecovery({ reload, log, onTerminal });

    recovery.handle({ reason: "crashed", exitCode: 11 });
    expect(reload).not.toHaveBeenCalled();
    await vi.runAllTimersAsync();
    expect(reload).toHaveBeenCalledOnce();

    recovery.handle({ reason: "crashed", exitCode: 11 });
    recovery.handle({ reason: "crashed", exitCode: 11 });

    expect(reload).toHaveBeenCalledOnce();
    expect(onTerminal).toHaveBeenCalledOnce();
    expect(onTerminal.mock.calls[0]?.[0]).toMatchObject({
      event: "renderer-recovery-terminal",
      reason: "crashed",
      exitCode: 11,
    });
  });

  it("ignores expected renderer exits", async () => {
    vi.useFakeTimers();
    const reload = vi.fn();
    const onTerminal = vi.fn();
    const recovery = new RendererCrashRecovery({
      reload,
      log: vi.fn(),
      onTerminal,
    });

    recovery.handle({ reason: "clean-exit", exitCode: 0 });
    recovery.handle({ reason: "killed", exitCode: 0 });
    await vi.runAllTimersAsync();

    expect(reload).not.toHaveBeenCalled();
    expect(onTerminal).not.toHaveBeenCalled();
  });

  it("surfaces non-recoverable exits without trying to reload", async () => {
    vi.useFakeTimers();
    const reload = vi.fn();
    const onTerminal = vi.fn();
    const recovery = new RendererCrashRecovery({
      reload,
      log: vi.fn(),
      onTerminal,
    });

    recovery.handle({ reason: "integrity-failure", exitCode: 1 });
    await vi.runAllTimersAsync();

    expect(reload).not.toHaveBeenCalled();
    expect(onTerminal).toHaveBeenCalledOnce();
  });

  it("contains logging and dialog failures while reporting a reload failure", async () => {
    vi.useFakeTimers();
    const terminalDiagnostics: RendererRecoveryDiagnostic[] = [];
    const recovery = new RendererCrashRecovery({
      reload: () => {
        throw new Error("webContents unavailable");
      },
      log: (diagnostic) => {
        if (diagnostic.event === "renderer-recovery-terminal") {
          terminalDiagnostics.push(diagnostic);
        } else {
          throw new Error("diagnostics unavailable");
        }
      },
      onTerminal: () => {
        throw new Error("dialog unavailable");
      },
    });

    expect(() => recovery.handle({ reason: "oom", exitCode: 9 })).not.toThrow();
    await vi.runAllTimersAsync();
    expect(terminalDiagnostics).toHaveLength(1);
    expect(terminalDiagnostics[0]?.message).toContain("webContents unavailable");
  });
});
