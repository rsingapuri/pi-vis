/// <reference lib="webworker" />

import { buildDiffModel } from "./diff-model.js";

export interface DiffModelWorkerRequest {
  requestId: number;
  oldText: string;
  newText: string;
}

export interface DiffModelWorkerResponse {
  requestId: number;
  model: ReturnType<typeof buildDiffModel>;
}

const worker = self as DedicatedWorkerGlobalScope;
worker.onmessage = (event: MessageEvent<DiffModelWorkerRequest>): void => {
  const request = event.data;
  const response: DiffModelWorkerResponse = {
    requestId: request.requestId,
    model: buildDiffModel(request.oldText, request.newText),
  };
  worker.postMessage(response);
};
