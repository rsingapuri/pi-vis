import type { AnyDiffModel, DiffModel, GapState } from "./diff-model.js";
import type { MatchSide, SearchMatch, SearchViewMode } from "./search.js";
import { matchId } from "./search.js";

export const PACKED_MATCH_STRIDE = 6;

const SIDE_TO_CODE: Record<MatchSide, number> = { context: 0, old: 1, new: 2 };
const CODE_TO_SIDE: MatchSide[] = ["context", "old", "new"];

export type DiffSearchSource =
  | { kind: "model"; model: DiffModel }
  | { kind: "texts"; oldText: string; newText: string };

export interface DiffSearchWorkerRequest {
  type: "search-file";
  requestId: number;
  generation: number;
  path: string;
  fileOrdinal: number;
  query: string;
  caseSensitive: boolean;
  viewMode: SearchViewMode;
  gapState: GapState[];
  source: DiffSearchSource;
}

export type DiffSearchWorkerStatus = "ok" | "too-large" | "binary" | "error";

export interface DiffSearchWorkerResponse {
  type: "search-result";
  requestId: number;
  generation: number;
  path: string;
  fileOrdinal: number;
  status: DiffSearchWorkerStatus;
  matches: ArrayBuffer;
  error?: string | undefined;
}

export interface PackedSearchFile {
  path: string;
  fileOrdinal: number;
  data: Int32Array;
}

export function packSearchMatches(matches: SearchMatch[]): ArrayBuffer {
  const packed = new Int32Array(matches.length * PACKED_MATCH_STRIDE);
  for (let i = 0; i < matches.length; i++) {
    const match = matches[i]!;
    const base = i * PACKED_MATCH_STRIDE;
    packed[base] = match.lineIdx;
    packed[base + 1] = match.rowIndex;
    packed[base + 2] = SIDE_TO_CODE[match.side];
    packed[base + 3] = match.occ;
    packed[base + 4] = match.start;
    packed[base + 5] = match.end;
  }
  return packed.buffer;
}

export function packedMatchCount(data: Int32Array): number {
  return Math.floor(data.length / PACKED_MATCH_STRIDE);
}

export function decodePackedMatch(
  data: Int32Array,
  index: number,
  path: string,
): SearchMatch | null {
  if (index < 0 || index >= packedMatchCount(data)) return null;
  const base = index * PACKED_MATCH_STRIDE;
  const lineIdx = data[base];
  const rowIndex = data[base + 1];
  const sideCode = data[base + 2];
  const occ = data[base + 3];
  const start = data[base + 4];
  const end = data[base + 5];
  if (
    lineIdx === undefined ||
    rowIndex === undefined ||
    sideCode === undefined ||
    occ === undefined ||
    start === undefined ||
    end === undefined
  ) {
    return null;
  }
  const side = CODE_TO_SIDE[sideCode];
  if (!side) return null;
  return {
    id: matchId(path, lineIdx, occ),
    path,
    lineIdx,
    rowIndex,
    side,
    occ,
    start,
    end,
    resultIndex: index,
  };
}

export function findPackedMatchIndex(data: Int32Array, match: SearchMatch): number {
  const count = packedMatchCount(data);
  const sideCode = SIDE_TO_CODE[match.side];
  const hinted = match.resultIndex;
  if (hinted !== undefined && hinted >= 0 && hinted < count) {
    const base = hinted * PACKED_MATCH_STRIDE;
    if (
      data[base] === match.lineIdx &&
      data[base + 2] === sideCode &&
      data[base + 3] === match.occ
    ) {
      return hinted;
    }
  }
  for (let i = 0; i < count; i++) {
    const base = i * PACKED_MATCH_STRIDE;
    if (
      data[base] === match.lineIdx &&
      data[base + 2] === sideCode &&
      data[base + 3] === match.occ
    ) {
      return i;
    }
  }
  return -1;
}

/** Shared by the module worker and the non-Worker compatibility fallback. */
export function runDiffSearchRequest(
  request: DiffSearchWorkerRequest,
  buildModel: (oldText: string, newText: string) => AnyDiffModel,
  search: (
    files: Array<{
      path: string;
      model: DiffModel;
      gapState: GapState[];
      viewMode: SearchViewMode;
    }>,
    query: string,
    caseSensitive: boolean,
  ) => SearchMatch[],
): DiffSearchWorkerResponse {
  try {
    const model =
      request.source.kind === "model"
        ? request.source.model
        : buildModel(request.source.oldText, request.source.newText);
    if (model.kind !== "ok") {
      return {
        type: "search-result",
        requestId: request.requestId,
        generation: request.generation,
        path: request.path,
        fileOrdinal: request.fileOrdinal,
        status: model.kind,
        matches: new ArrayBuffer(0),
      };
    }
    const matches = search(
      [
        {
          path: request.path,
          model,
          gapState: request.gapState,
          viewMode: request.viewMode,
        },
      ],
      request.query,
      request.caseSensitive,
    );
    return {
      type: "search-result",
      requestId: request.requestId,
      generation: request.generation,
      path: request.path,
      fileOrdinal: request.fileOrdinal,
      status: "ok",
      matches: packSearchMatches(matches),
    };
  } catch (error) {
    return {
      type: "search-result",
      requestId: request.requestId,
      generation: request.generation,
      path: request.path,
      fileOrdinal: request.fileOrdinal,
      status: "error",
      matches: new ArrayBuffer(0),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
