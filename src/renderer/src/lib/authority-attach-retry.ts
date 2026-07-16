import type { SessionId } from "@shared/ids.js";
import type { RendererAttachResult } from "@shared/ipc-contract.js";
import type { AuthorityAttachResponse } from "@shared/pi-protocol/runtime-state.js";

interface InFlightAttach {
  cancelled: boolean;
  promise: Promise<void>;
}

export interface AuthorityAttachRetryOptions {
  sessionExists: (sessionId: SessionId) => boolean;
  needsAttach: (sessionId: SessionId) => boolean;
  rendererAttach: (sessionId: SessionId) => Promise<RendererAttachResult>;
  authorityAttach: (sessionId: SessionId) => Promise<AuthorityAttachResponse>;
  onReady: (sessionId: SessionId, response: AuthorityAttachResponse) => void;
  onUnavailable: (sessionId: SessionId) => void;
}

/** Bounded, single-flight authority attach with cancellation on session removal. */
export class AuthorityAttachRetry {
  private readonly inFlight = new Map<SessionId, InFlightAttach>();
  private readonly retries = new Map<SessionId, number>();
  private readonly timers = new Map<SessionId, ReturnType<typeof setTimeout>>();

  constructor(private readonly options: AuthorityAttachRetryOptions) {}

  request(sessionId: SessionId): Promise<void> {
    if (!this.options.sessionExists(sessionId)) {
      this.cancel(sessionId);
      return Promise.resolve();
    }
    if (!this.options.needsAttach(sessionId)) {
      this.clearRetry(sessionId);
      return Promise.resolve();
    }
    const pending = this.inFlight.get(sessionId);
    if (pending) return pending.promise;

    const attach: InFlightAttach = { cancelled: false, promise: Promise.resolve() };
    const active = (): boolean => !attach.cancelled && this.options.sessionExists(sessionId);
    const scheduleRetry = (): void => {
      if (!active()) {
        this.cancel(sessionId);
        return;
      }
      const attempt = this.retries.get(sessionId) ?? 0;
      // 250ms, 500ms, 1s, 2s, then capped 4s. A bounded retry avoids both
      // focus storms and permanently hiding a genuinely unavailable host.
      if (attempt >= 6) {
        this.retries.delete(sessionId);
        if (active()) this.options.onUnavailable(sessionId);
        return;
      }
      this.retries.set(sessionId, attempt + 1);
      const delay = Math.min(4_000, 250 * 2 ** attempt);
      const prior = this.timers.get(sessionId);
      if (prior) clearTimeout(prior);
      const timer = setTimeout(() => {
        this.timers.delete(sessionId);
        if (!this.options.sessionExists(sessionId)) {
          this.cancel(sessionId);
          return;
        }
        void this.request(sessionId);
      }, delay);
      this.timers.set(sessionId, timer);
    };

    attach.promise = (async () => {
      try {
        const rendererResult = await this.options.rendererAttach(sessionId);
        // A close can occur while the first IPC is transitioning. Do not send
        // the second IPC or schedule work for the now-dead session. Main also
        // reports a close/attach race as typed unavailability, never an IPC
        // exception that Electron logs as a failed handler.
        if (!active()) return;
        if (rendererResult.status === "unavailable") {
          scheduleRetry();
          return;
        }
        const response = await this.options.authorityAttach(sessionId);
        if (!active()) return;
        if (response.status === "ready") {
          this.clearRetry(sessionId);
          this.options.onReady(sessionId, response);
          return;
        }
        scheduleRetry();
      } catch {
        // IPC transport loss is also a normal lifecycle boundary. Retry it
        // through the same bounded single-flight path without surfacing raw
        // Electron handler text to the user.
        if (active()) scheduleRetry();
      }
    })();
    this.inFlight.set(sessionId, attach);
    void attach.promise.finally(() => {
      if (this.inFlight.get(sessionId) === attach) this.inFlight.delete(sessionId);
    });
    return attach.promise;
  }

  /** Stop every retry path and forget all bookkeeping for this session. */
  cancel(sessionId: SessionId): void {
    const timer = this.timers.get(sessionId);
    if (timer) clearTimeout(timer);
    this.timers.delete(sessionId);
    this.retries.delete(sessionId);
    const attach = this.inFlight.get(sessionId);
    if (attach) attach.cancelled = true;
    this.inFlight.delete(sessionId);
  }

  cancelAll(): void {
    for (const sessionId of new Set([
      ...this.timers.keys(),
      ...this.retries.keys(),
      ...this.inFlight.keys(),
    ])) {
      this.cancel(sessionId);
    }
  }

  private clearRetry(sessionId: SessionId): void {
    const timer = this.timers.get(sessionId);
    if (timer) clearTimeout(timer);
    this.timers.delete(sessionId);
    this.retries.delete(sessionId);
  }
}
