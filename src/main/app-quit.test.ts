import { describe, expect, it, vi } from "vitest";
import {
  APP_QUIT_DRAIN_TIMEOUT_MS,
  type BeforeQuitEvent,
  installBeforeQuitFence,
} from "./app-quit.js";

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

const flushPromises = () => new Promise<void>((resolve) => setImmediate(resolve));

function harness() {
  let listener: ((event: BeforeQuitEvent) => void) | undefined;
  const app = {
    on: vi.fn((_event: "before-quit", next: (event: BeforeQuitEvent) => void) => {
      listener = next;
    }),
    quit: vi.fn(),
  };
  const emit = () => {
    const event = { preventDefault: vi.fn() };
    if (!listener) throw new Error("before-quit listener was not installed");
    listener(event);
    return event;
  };
  return { app, emit };
}

describe("before-quit session drain", () => {
  it("awaits one shared teardown and allows only the final quit through", async () => {
    const h = harness();
    const stopped = deferred();
    const stop = vi.fn(() => stopped.promise);
    let nested: ReturnType<typeof h.emit> | undefined;
    let emitNested = true;
    const begin = vi.fn(() => {
      if (!emitNested) return;
      emitNested = false;
      nested = h.emit();
    });
    installBeforeQuitFence({ app: h.app, stop, begin });

    const first = h.emit();
    const reentrant = h.emit();
    await Promise.resolve();

    expect(first.preventDefault).toHaveBeenCalledOnce();
    expect(nested?.preventDefault).toHaveBeenCalledOnce();
    expect(reentrant.preventDefault).toHaveBeenCalledOnce();
    expect(begin).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledOnce();
    expect(h.app.quit).not.toHaveBeenCalled();

    stopped.resolve();
    await stopped.promise;
    await flushPromises();

    expect(h.app.quit).toHaveBeenCalledOnce();
    const final = h.emit();
    expect(final.preventDefault).not.toHaveBeenCalled();
    expect(stop).toHaveBeenCalledOnce();
  });

  it("continues quitting after the bounded host escalation budget", async () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      const timeout = vi.fn();
      installBeforeQuitFence({
        app: h.app,
        stop: () => new Promise(() => {}),
        onTimeout: timeout,
      });

      h.emit();
      await vi.advanceTimersByTimeAsync(APP_QUIT_DRAIN_TIMEOUT_MS);

      expect(timeout).toHaveBeenCalledWith(APP_QUIT_DRAIN_TIMEOUT_MS);
      expect(h.app.quit).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports teardown rejection and still completes quit", async () => {
    const h = harness();
    const error = new Error("stop failed");
    const onError = vi.fn();
    installBeforeQuitFence({
      app: h.app,
      stop: () => Promise.reject(error),
      onError,
    });

    h.emit();
    await flushPromises();

    expect(onError).toHaveBeenCalledWith(error);
    expect(h.app.quit).toHaveBeenCalledOnce();
  });
});
