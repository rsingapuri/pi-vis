import { buildDiffModel } from "./diff-model.js";
import type { DiffSearchWorkerRequest, DiffSearchWorkerResponse } from "./diff-search-protocol.js";
import { runDiffSearchRequest } from "./diff-search-protocol.js";
import { computeMatches } from "./search.js";

interface WorkerLike {
  onmessage: ((event: MessageEvent<DiffSearchWorkerResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  postMessage(message: DiffSearchWorkerRequest): void;
  terminate(): void;
}

export type DiffSearchWorkerFactory = () => WorkerLike;

function defaultWorkerFactory(): WorkerLike {
  return new Worker(new URL("./diff-search.worker.ts", import.meta.url), {
    type: "module",
    name: "pivis-diff-search",
  });
}

interface PendingRequest {
  request: DiffSearchWorkerRequest;
  resolve: (response: DiffSearchWorkerResponse) => void;
  reject: (error: Error) => void;
}

export class DiffSearchWorkerClient {
  private worker: WorkerLike | null = null;
  private fallback: boolean;
  private disposed = false;
  private nextRequestId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly fallbackTimers = new Set<ReturnType<typeof setTimeout>>();

  constructor(workerFactory: DiffSearchWorkerFactory = defaultWorkerFactory) {
    try {
      this.worker = workerFactory();
      this.worker.onmessage = (event) => this.handleMessage(event.data);
      this.worker.onerror = () => {
        // A worker can fail transiently (bundle/CSP/runtime). Preserve search
        // completeness by replaying every in-flight request through the same
        // pure engine's async compatibility path, then keep using that path.
        this.switchToFallback();
      };
      this.fallback = false;
    } catch {
      // Vitest's Node environment and unusually strict browser policies do not
      // provide Worker. Keep correctness with an asynchronous compatibility
      // path; packaged Electron uses the module worker.
      this.worker = null;
      this.fallback = true;
    }
  }

  search(
    request: Omit<DiffSearchWorkerRequest, "requestId" | "type">,
  ): Promise<DiffSearchWorkerResponse> {
    if (this.disposed) return Promise.reject(new Error("Diff search worker disposed"));
    const requestId = this.nextRequestId++;
    const fullRequest: DiffSearchWorkerRequest = {
      ...request,
      type: "search-file",
      requestId,
    };

    return new Promise((resolve, reject) => {
      this.pending.set(requestId, { request: fullRequest, resolve, reject });
      if (this.fallback) {
        this.scheduleFallback(requestId);
        return;
      }
      try {
        this.worker?.postMessage(fullRequest);
      } catch {
        this.switchToFallback();
      }
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const timer of this.fallbackTimers) clearTimeout(timer);
    this.fallbackTimers.clear();
    this.worker?.terminate();
    this.worker = null;
    this.failAll(new Error("Diff search worker disposed"));
  }

  private handleMessage(response: DiffSearchWorkerResponse): void {
    const pending = this.pending.get(response.requestId);
    if (!pending) return;
    this.pending.delete(response.requestId);
    pending.resolve(response);
  }

  private switchToFallback(): void {
    if (this.disposed || this.fallback) return;
    this.worker?.terminate();
    this.worker = null;
    this.fallback = true;
    for (const requestId of this.pending.keys()) this.scheduleFallback(requestId);
  }

  private scheduleFallback(requestId: number): void {
    const timer = setTimeout(() => {
      this.fallbackTimers.delete(timer);
      const pending = this.pending.get(requestId);
      if (!pending) return;
      this.pending.delete(requestId);
      if (this.disposed) {
        pending.reject(new Error("Diff search worker disposed"));
        return;
      }
      pending.resolve(runDiffSearchRequest(pending.request, buildDiffModel, computeMatches));
    }, 0);
    this.fallbackTimers.add(timer);
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}
