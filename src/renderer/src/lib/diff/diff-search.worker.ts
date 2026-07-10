/// <reference lib="webworker" />

import { buildDiffModel } from "./diff-model.js";
import type { DiffSearchWorkerRequest } from "./diff-search-protocol.js";
import { runDiffSearchRequest } from "./diff-search-protocol.js";
import { computeMatches } from "./search.js";

const worker = self as DedicatedWorkerGlobalScope;

worker.onmessage = (event: MessageEvent<DiffSearchWorkerRequest>): void => {
  const response = runDiffSearchRequest(event.data, buildDiffModel, computeMatches);
  worker.postMessage(response, [response.matches]);
};
