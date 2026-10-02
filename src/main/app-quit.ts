export interface BeforeQuitEvent {
  preventDefault(): void;
}

export interface QuitFenceApp {
  on(event: "before-quit", listener: (event: BeforeQuitEvent) => void): unknown;
  quit(): void;
}

export interface BeforeQuitFenceOptions {
  app: QuitFenceApp;
  stop: () => Promise<void>;
  begin?: () => void;
  timeoutMs?: number;
  onError?: (error: unknown) => void;
  onTimeout?: (timeoutMs: number) => void;
}

/**
 * SessionHost's planned shutdown waits 4.5 seconds before TERM and another
 * three seconds before KILL. Keep the app alive slightly beyond that complete
 * escalation budget, but never let a broken child-process implementation hold
 * Electron's quit forever.
 */
export const APP_QUIT_DRAIN_TIMEOUT_MS = 8_500;

function reportSafely(callback: (() => void) | undefined): void {
  try {
    callback?.();
  } catch {
    // Diagnostics must never turn a bounded quit path into another failure.
  }
}

/**
 * Delay Electron's first before-quit event until asynchronous host/session
 * teardown settles. Re-entrant quit requests share that teardown. The one
 * app.quit() issued after settlement is allowed through without recursively
 * starting another drain.
 */
export function installBeforeQuitFence(options: BeforeQuitFenceOptions): void {
  const timeoutMs = options.timeoutMs ?? APP_QUIT_DRAIN_TIMEOUT_MS;
  let allowQuit = false;
  let drainStarted = false;

  options.app.on("before-quit", (event) => {
    if (allowQuit) return;

    event.preventDefault();
    if (drainStarted) return;
    // Publish the re-entry fence before invoking any caller hook. Even a
    // synchronous app.quit() from begin/onError/onTimeout must join this one
    // drain instead of recursively constructing another shutdown pipeline.
    drainStarted = true;

    reportSafely(options.begin);

    // Install rejection handling immediately. If the deadline wins, a later
    // stop rejection still cannot become an unhandled rejection.
    const stop = Promise.resolve()
      .then(options.stop)
      .catch((error) => reportSafely(() => options.onError?.(error)));

    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        reportSafely(() => options.onTimeout?.(timeoutMs));
        resolve();
      }, timeoutMs);
      timer.unref?.();
    });

    void Promise.race([stop, deadline])
      .finally(() => {
        if (timer) clearTimeout(timer);
      })
      .then(() => {
        allowQuit = true;
        options.app.quit();
      });
  });
}
