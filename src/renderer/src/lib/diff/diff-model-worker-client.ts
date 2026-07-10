import type { AnyDiffModel } from "./diff-model.js";
import { buildDiffModel } from "./diff-model.js";

interface DiffModelWorkerRequest {
  requestId: number;
  oldText: string;
  newText: string;
}

interface DiffModelWorkerResponse {
  requestId: number;
  model: AnyDiffModel;
}

interface PendingBuild {
  request: DiffModelWorkerRequest;
  resolve: (model: AnyDiffModel) => void;
  reject: (error: Error) => void;
}

class DiffModelWorkerClient {
  private worker: Worker | null = null;
  private fallback = false;
  private nextRequestId = 1;
  private readonly pending = new Map<number, PendingBuild>();

  constructor() {
    try {
      this.worker = new Worker(new URL("./diff-model.worker.ts", import.meta.url), {
        type: "module",
        name: "pivis-diff-model",
      });
      this.worker.onmessage = (event: MessageEvent<DiffModelWorkerResponse>) => {
        const pending = this.pending.get(event.data.requestId);
        if (!pending) return;
        this.pending.delete(event.data.requestId);
        pending.resolve(event.data.model);
      };
      this.worker.onerror = () => this.switchToFallback();
    } catch {
      this.fallback = true;
      this.worker = null;
    }
  }

  build(oldText: string, newText: string): Promise<AnyDiffModel> {
    const request: DiffModelWorkerRequest = {
      requestId: this.nextRequestId++,
      oldText,
      newText,
    };
    return new Promise((resolve, reject) => {
      this.pending.set(request.requestId, { request, resolve, reject });
      if (this.fallback) {
        this.scheduleFallback(request.requestId);
        return;
      }
      try {
        this.worker?.postMessage(request);
      } catch {
        this.switchToFallback();
      }
    });
  }

  private switchToFallback(): void {
    if (this.fallback) return;
    this.worker?.terminate();
    this.worker = null;
    this.fallback = true;
    for (const requestId of this.pending.keys()) this.scheduleFallback(requestId);
  }

  private scheduleFallback(requestId: number): void {
    setTimeout(() => {
      const pending = this.pending.get(requestId);
      if (!pending) return;
      this.pending.delete(requestId);
      try {
        pending.resolve(buildDiffModel(pending.request.oldText, pending.request.newText));
      } catch (error) {
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      }
    }, 0);
  }
}

let singleton: DiffModelWorkerClient | null = null;

/** Build a diff model away from the renderer's interaction task. */
export function buildDiffModelAsync(oldText: string, newText: string): Promise<AnyDiffModel> {
  singleton ??= new DiffModelWorkerClient();
  return singleton.build(oldText, newText);
}
