import type { SessionId } from "@shared/ids.js";
import type {
  AuthorityCursor,
  IntentEnvelope,
  IntentReceipt,
  RuntimeIdentity,
  SessionIntent,
  SessionQuery,
  SessionQueryResult,
} from "@shared/pi-protocol/runtime-state.js";
import { RENDERER_GENERATION } from "./renderer-generation.js";

export interface AuthorityObservation {
  owner: RuntimeIdentity;
  cursor?: AuthorityCursor | undefined;
}

/** Dispatches a stable owner-bound mutation. Completion is published by authority frames. */
export function dispatchSessionIntent(
  sessionId: SessionId,
  intent: SessionIntent,
  observation: AuthorityObservation,
  intentId: string = crypto.randomUUID(),
): Promise<IntentReceipt> {
  const envelope: IntentEnvelope = {
    sessionId,
    intentId,
    rendererGeneration: RENDERER_GENERATION,
    expectedOwner: observation.owner,
    ...(observation.cursor ? { observedCursor: observation.cursor } : {}),
    intent,
  };
  return window.pivis.invoke("session.dispatchIntent", envelope);
}

/** Executes an owner-bound read. Queries never mutate canonical renderer state. */
export function querySession(
  sessionId: SessionId,
  query: SessionQuery,
  observation: AuthorityObservation,
): Promise<SessionQueryResult> {
  return window.pivis.invoke("session.query", {
    sessionId,
    queryId: crypto.randomUUID(),
    expectedOwner: observation.owner,
    ...(observation.cursor ? { observedCursor: observation.cursor } : {}),
    query,
  });
}
