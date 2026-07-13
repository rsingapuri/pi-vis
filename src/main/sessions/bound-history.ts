import path from "node:path";
import type { SessionId } from "@shared/ids.js";
import type { TranscriptBlock } from "@shared/ipc-contract.js";
import type { SessionRecord } from "./session-registry.js";

export interface BoundHistoryRequest {
  sessionId: SessionId;
  expectedSessionFile: string;
  historyGeneration: number;
  expectedHostInstanceId: string | null;
  expectedSessionEpoch: number | null;
}

export type BoundHistoryResult =
  | { status: "loaded"; historyGeneration: number; history: TranscriptBlock[] }
  | { status: "stale"; historyGeneration: number };

type HistoryLoader = (filePath: string) => Promise<TranscriptBlock[]>;

interface CapturedHistoryOwner {
  record: SessionRecord;
  sessionFile: string;
  proc: SessionRecord["proc"];
  hostInstanceId?: string | undefined;
  sessionEpoch?: number | undefined;
}

function runtimeIdentity(record: SessionRecord): {
  hostInstanceId?: string | undefined;
  sessionEpoch?: number | undefined;
} {
  return {
    hostInstanceId: record.snapshot?.hostInstanceId ?? record.proc?.hostInstanceId,
    sessionEpoch: record.snapshot?.sessionEpoch ?? record.proc?.sessionEpoch,
  };
}

function matchesRequest(record: SessionRecord, request: BoundHistoryRequest): boolean {
  if (!record.sessionFile) return false;
  if (path.resolve(record.sessionFile) !== path.resolve(request.expectedSessionFile)) return false;
  const hasHost = request.expectedHostInstanceId !== null;
  const hasEpoch = request.expectedSessionEpoch !== null;
  if (hasHost !== hasEpoch) return false;
  const identity = runtimeIdentity(record);
  // Identity-less requests are cold-owner reads only. If activation won the
  // race before main admitted the request, force the renderer to retry with
  // the now-authoritative host/epoch instead of silently rebinding it.
  if (!hasHost) {
    return (
      record.status === "cold" &&
      !record._activating &&
      record.availability === "unavailable" &&
      !record.proc &&
      identity.hostInstanceId === undefined &&
      identity.sessionEpoch === undefined
    );
  }
  return (
    record.status === "ready" &&
    record.availability === "available" &&
    !record._hostTransition &&
    identity.hostInstanceId === request.expectedHostInstanceId &&
    identity.sessionEpoch === request.expectedSessionEpoch
  );
}

function captureOwner(record: SessionRecord): CapturedHistoryOwner {
  const identity = runtimeIdentity(record);
  return {
    record,
    sessionFile: path.resolve(record.sessionFile!),
    proc: record.proc,
    hostInstanceId: identity.hostInstanceId,
    sessionEpoch: identity.sessionEpoch,
  };
}

function ownerStillCurrent(
  current: SessionRecord | undefined,
  captured: CapturedHistoryOwner,
): boolean {
  if (!current || current !== captured.record || !current.sessionFile) return false;
  const identity = runtimeIdentity(current);
  if (
    captured.proc === undefined &&
    (current.status !== "cold" || current._activating || current.availability !== "unavailable")
  )
    return false;
  if (
    captured.hostInstanceId !== undefined &&
    (current.status !== "ready" ||
      current.availability !== "available" ||
      current._hostTransition !== undefined)
  )
    return false;
  return (
    path.resolve(current.sessionFile) === captured.sessionFile &&
    current.proc === captured.proc &&
    identity.hostInstanceId === captured.hostInstanceId &&
    identity.sessionEpoch === captured.sessionEpoch
  );
}

/**
 * Read persisted history against one captured session owner. Both renderer-
 * supplied expectations and main's actual file/process/runtime binding are
 * checked before and after asynchronous I/O, so a predecessor read can never
 * silently follow or apply to a replacement record.
 */
export async function loadBoundHistory(
  request: BoundHistoryRequest,
  getSession: (sessionId: SessionId) => SessionRecord | undefined,
  load: HistoryLoader,
): Promise<BoundHistoryResult> {
  const stale = (): BoundHistoryResult => ({
    status: "stale",
    historyGeneration: request.historyGeneration,
  });
  const record = getSession(request.sessionId);
  if (!record || !matchesRequest(record, request)) return stale();
  const captured = captureOwner(record);
  const history = await load(captured.sessionFile);
  if (!ownerStillCurrent(getSession(request.sessionId), captured)) return stale();
  return { status: "loaded", historyGeneration: request.historyGeneration, history };
}
