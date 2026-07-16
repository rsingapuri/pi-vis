import type { SessionId } from "@shared/ids.js";
import type { RendererAttachResult } from "@shared/ipc-contract.js";
import type { AuthorityAttachResponse } from "@shared/pi-protocol/runtime-state.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthorityAttachRetry } from "./authority-attach-retry.js";

const SID = "session-a" as SessionId;
const transitioning = { status: "transitioning" } as AuthorityAttachResponse;
const attached = {
  status: "attached",
  runtime: { availability: "unavailable", receivedAt: 0 },
} satisfies RendererAttachResult;

describe("AuthorityAttachRetry", () => {
  afterEach(() => vi.useRealTimers());

  it("does not retry after a transitioning attach session is removed", async () => {
    vi.useFakeTimers();
    const sessions = new Set<SessionId>([SID]);
    const rendererAttach = vi.fn().mockResolvedValue(attached);
    const authorityAttach = vi.fn().mockResolvedValue(transitioning);
    const retry = new AuthorityAttachRetry({
      sessionExists: (sessionId) => sessions.has(sessionId),
      needsAttach: () => true,
      rendererAttach,
      authorityAttach,
      onReady: vi.fn(),
      onUnavailable: vi.fn(),
    });

    await retry.request(SID);
    expect(rendererAttach).toHaveBeenCalledTimes(1);
    expect(authorityAttach).toHaveBeenCalledTimes(1);

    const removeSession = (): void => {
      sessions.delete(SID);
      retry.cancel(SID); // mirrors App's synchronous removeSession subscription
    };
    removeSession();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(rendererAttach).toHaveBeenCalledTimes(1);
    expect(authorityAttach).toHaveBeenCalledTimes(1);
  });

  it("retries typed renderer unavailability without issuing authorityAttach", async () => {
    vi.useFakeTimers();
    const rendererAttach = vi
      .fn<() => Promise<RendererAttachResult>>()
      .mockResolvedValueOnce({ status: "unavailable", reason: "session_closing" })
      .mockResolvedValue(attached);
    const authorityAttach = vi.fn().mockResolvedValue(transitioning);
    const retry = new AuthorityAttachRetry({
      sessionExists: () => true,
      needsAttach: () => true,
      rendererAttach,
      authorityAttach,
      onReady: vi.fn(),
      onUnavailable: vi.fn(),
    });

    await retry.request(SID);
    expect(authorityAttach).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(250);
    expect(rendererAttach).toHaveBeenCalledTimes(2);
    expect(authorityAttach).toHaveBeenCalledTimes(1);
    retry.cancelAll();
  });

  it("does not issue the second attach IPC when removal races rendererAttach", async () => {
    let resolveRendererAttach: ((result: RendererAttachResult) => void) | undefined;
    const rendererAttach = vi.fn(
      () =>
        new Promise<RendererAttachResult>((resolve) => {
          resolveRendererAttach = resolve;
        }),
    );
    const authorityAttach = vi.fn().mockResolvedValue(transitioning);
    const sessions = new Set<SessionId>([SID]);
    const retry = new AuthorityAttachRetry({
      sessionExists: (sessionId) => sessions.has(sessionId),
      needsAttach: () => true,
      rendererAttach,
      authorityAttach,
      onReady: vi.fn(),
      onUnavailable: vi.fn(),
    });

    const attaching = retry.request(SID);
    sessions.delete(SID);
    retry.cancel(SID);
    resolveRendererAttach?.(attached);
    await attaching;

    expect(rendererAttach).toHaveBeenCalledTimes(1);
    expect(authorityAttach).not.toHaveBeenCalled();
  });
});
