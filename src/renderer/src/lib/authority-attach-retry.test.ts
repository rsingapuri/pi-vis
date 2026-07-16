import type { SessionId } from "@shared/ids.js";
import type { AuthorityAttachResponse } from "@shared/pi-protocol/runtime-state.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthorityAttachRetry } from "./authority-attach-retry.js";

const SID = "session-a" as SessionId;
const transitioning = { status: "transitioning" } as AuthorityAttachResponse;

describe("AuthorityAttachRetry", () => {
  afterEach(() => vi.useRealTimers());

  it("does not retry after a transitioning attach session is removed", async () => {
    vi.useFakeTimers();
    const sessions = new Set<SessionId>([SID]);
    const rendererAttach = vi.fn().mockResolvedValue(undefined);
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

  it("does not issue the second attach IPC when removal races rendererAttach", async () => {
    let resolveRendererAttach: (() => void) | undefined;
    const rendererAttach = vi.fn(
      () =>
        new Promise<void>((resolve) => {
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
    resolveRendererAttach?.();
    await attaching;

    expect(rendererAttach).toHaveBeenCalledTimes(1);
    expect(authorityAttach).not.toHaveBeenCalled();
  });
});
