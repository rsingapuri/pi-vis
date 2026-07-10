import type { GitChangedFile } from "@shared/git.js";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type PackedSearchFile,
  decodePackedMatch,
  findPackedMatchIndex,
  packedMatchCount,
} from "../lib/diff/diff-search-protocol.js";
import { DiffSearchWorkerClient } from "../lib/diff/diff-search-worker-client.js";
import type { SearchMatch, SearchViewMode } from "../lib/diff/search.js";
import { useDiffStore } from "../stores/diff-store.js";

const SEARCH_DEBOUNCE_MS = 100;
const SEARCH_FILE_CONCURRENCY = 2;

interface DiffSearchSnapshot {
  generation: number;
  status: "idle" | "debouncing" | "searching" | "complete";
  results: Map<string, PackedSearchFile>;
  count: number;
  completedFiles: number;
  totalFiles: number;
  failedFiles: number;
  skippedFiles: number;
}

const EMPTY_SNAPSHOT: DiffSearchSnapshot = {
  generation: 0,
  status: "idle",
  results: new Map(),
  count: 0,
  completedFiles: 0,
  totalFiles: 0,
  failedFiles: 0,
  skippedFiles: 0,
};

export interface DiffSearchIndex {
  count: number;
  activeStatus: "idle" | "debouncing" | "searching" | "complete";
  searching: boolean;
  completedFiles: number;
  totalFiles: number;
  failedFiles: number;
  skippedFiles: number;
  revision: number;
  getMatchAt: (index: number) => SearchMatch | null;
  indexOfMatch: (match: SearchMatch | null) => number;
}

interface UseDiffSearchOptions {
  enabled: boolean;
  query: string;
  caseSensitive: boolean;
  viewMode: SearchViewMode;
  root: string | null;
  base: string | null;
  files: GitChangedFile[];
  /** Changes only when explicitly revealed gap context changes. */
  projectionKey: string;
}

/**
 * Progressive, worker-backed diff search. File contents are fetched with
 * bounded concurrency and scanned away from React. Results remain packed in
 * per-file typed arrays; navigation decodes only the active occurrence.
 */
export function useDiffSearch({
  enabled,
  query,
  caseSensitive,
  viewMode,
  root,
  base,
  files,
  projectionKey,
}: UseDiffSearchOptions): DiffSearchIndex {
  const [snapshot, setSnapshot] = useState<DiffSearchSnapshot>(EMPTY_SNAPSHOT);
  const generationRef = useRef(0);

  useEffect(() => {
    // This primitive snapshot deliberately restarts discovery when revealed-gap
    // scope changes, even though the scan reads the current state lazily.
    void projectionKey;
    const generation = ++generationRef.current;
    if (!enabled || query === "" || root === null) {
      setSnapshot({ ...EMPTY_SNAPSHOT, generation });
      return;
    }

    let cancelled = false;
    let client: DiffSearchWorkerClient | null = null;
    let flushFrame: number | null = null;
    const pendingCompletions: Array<{
      file: GitChangedFile;
      result: PackedSearchFile | null;
      outcome: "ok" | "failed" | "skipped";
    }> = [];

    const flushCompletions = (): void => {
      if (flushFrame !== null) {
        cancelAnimationFrame(flushFrame);
        flushFrame = null;
      }
      if (pendingCompletions.length === 0) return;
      const batch = pendingCompletions.splice(0);
      if (cancelled || generationRef.current !== generation) return;
      setSnapshot((current) => {
        if (current.generation !== generation) return current;
        let results = current.results;
        let added = 0;
        let failed = 0;
        let skipped = 0;
        for (const completion of batch) {
          if (completion.result) {
            if (results === current.results) results = new Map(results);
            results.set(completion.file.path, completion.result);
            added += packedMatchCount(completion.result.data);
          }
          if (completion.outcome === "failed") failed++;
          if (completion.outcome === "skipped") skipped++;
        }
        const completedFiles = current.completedFiles + batch.length;
        return {
          ...current,
          results,
          count: current.count + added,
          completedFiles,
          failedFiles: current.failedFiles + failed,
          skippedFiles: current.skippedFiles + skipped,
          status: completedFiles >= current.totalFiles ? "complete" : current.status,
        };
      });
    };

    const scheduleFlush = (): void => {
      if (flushFrame !== null) return;
      flushFrame = requestAnimationFrame(() => {
        flushFrame = null;
        flushCompletions();
      });
    };

    setSnapshot({
      ...EMPTY_SNAPSHOT,
      generation,
      status: "debouncing",
      totalFiles: files.length,
    });

    const timer = setTimeout(() => {
      if (cancelled) return;
      client = new DiffSearchWorkerClient();
      setSnapshot((current) =>
        current.generation === generation ? { ...current, status: "searching" } : current,
      );

      let cursor = 0;
      const complete = (
        file: GitChangedFile,
        result: PackedSearchFile | null,
        outcome: "ok" | "failed" | "skipped",
      ): void => {
        if (cancelled || generationRef.current !== generation) return;
        pendingCompletions.push({ file, result, outcome });
        scheduleFlush();
      };

      const scanFile = async (file: GitChangedFile, ordinal: number): Promise<void> => {
        if (cancelled || !client) return;
        if (file.binary) {
          complete(file, null, "skipped");
          return;
        }

        try {
          const ready = useDiffStore.getState().fileState.get(file.path);
          let source:
            | { kind: "model"; model: import("../lib/diff/diff-model.js").DiffModel }
            | { kind: "texts"; oldText: string; newText: string };
          let gapState = ready?.gapState ?? [];

          if (ready?.status === "ready" && ready.model?.kind === "ok") {
            source = { kind: "model", model: ready.model };
          } else if (
            ready?.status === "ready" &&
            (ready.model?.kind === "binary" || ready.model?.kind === "too-large")
          ) {
            complete(file, null, "skipped");
            return;
          } else {
            const params = {
              root,
              path: file.path,
              status: file.status,
              untracked: file.untracked,
              ...(base !== null ? { base } : {}),
              ...(file.oldPath !== undefined ? { oldPath: file.oldPath } : {}),
            };
            const response = await window.pivis.invoke("git.fileDiff", params);
            if (cancelled || generationRef.current !== generation) return;
            if (response.kind !== "ok") {
              complete(file, null, "failed");
              return;
            }
            if (response.binary || response.tooLarge) {
              complete(file, null, "skipped");
              return;
            }
            source = { kind: "texts", oldText: response.oldText, newText: response.newText };
            gapState = [];
          }

          const response = await client.search({
            generation,
            path: file.path,
            fileOrdinal: ordinal,
            query,
            caseSensitive,
            viewMode,
            gapState,
            source,
          });
          if (cancelled || generationRef.current !== generation) return;
          if (response.status !== "ok") {
            complete(file, null, response.status === "error" ? "failed" : "skipped");
            return;
          }
          complete(
            file,
            {
              path: file.path,
              fileOrdinal: ordinal,
              data: new Int32Array(response.matches),
            },
            "ok",
          );
        } catch {
          complete(file, null, "failed");
        }
      };

      const runner = async (): Promise<void> => {
        while (!cancelled) {
          const ordinal = cursor++;
          const file = files[ordinal];
          if (!file) return;
          await scanFile(file, ordinal);
        }
      };
      const runners = Array.from(
        { length: Math.min(SEARCH_FILE_CONCURRENCY, Math.max(1, files.length)) },
        () => runner(),
      );
      void Promise.all(runners).then(() => {
        if (cancelled || generationRef.current !== generation) return;
        flushCompletions();
        setSnapshot((current) =>
          current.generation === generation ? { ...current, status: "complete" } : current,
        );
      });
    }, SEARCH_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
      if (flushFrame !== null) cancelAnimationFrame(flushFrame);
      pendingCompletions.length = 0;
      client?.dispose();
    };
  }, [enabled, query, caseSensitive, viewMode, root, base, files, projectionKey]);

  const orderedResults = useMemo(() => {
    let start = 0;
    const starts = new Map<string, number>();
    const entries = Array.from(snapshot.results.values())
      .sort((a, b) => a.fileOrdinal - b.fileOrdinal)
      .map((result) => {
        const count = packedMatchCount(result.data);
        const entry = { result, start, count };
        starts.set(result.path, start);
        start += count;
        return entry;
      });
    return { entries, starts };
  }, [snapshot.results]);

  const getMatchAt = useCallback(
    (index: number): SearchMatch | null => {
      if (index < 0 || index >= snapshot.count) return null;
      let lo = 0;
      let hi = orderedResults.entries.length - 1;
      while (lo <= hi) {
        const mid = Math.floor((lo + hi) / 2);
        const entry = orderedResults.entries[mid];
        if (!entry) return null;
        if (index < entry.start) {
          hi = mid - 1;
        } else if (index >= entry.start + entry.count) {
          lo = mid + 1;
        } else {
          return decodePackedMatch(entry.result.data, index - entry.start, entry.result.path);
        }
      }
      return null;
    },
    [snapshot.count, orderedResults.entries],
  );

  const indexOfMatch = useCallback(
    (match: SearchMatch | null): number => {
      if (!match) return -1;
      const result = snapshot.results.get(match.path);
      const start = orderedResults.starts.get(match.path);
      if (!result || start === undefined) return -1;
      const local = findPackedMatchIndex(result.data, match);
      return local < 0 ? -1 : start + local;
    },
    [snapshot.results, orderedResults.starts],
  );

  return useMemo(
    () => ({
      count: snapshot.count,
      activeStatus: snapshot.status,
      searching: snapshot.status === "debouncing" || snapshot.status === "searching",
      completedFiles: snapshot.completedFiles,
      totalFiles: snapshot.totalFiles,
      failedFiles: snapshot.failedFiles,
      skippedFiles: snapshot.skippedFiles,
      revision: snapshot.generation * 1_000_000 + snapshot.completedFiles,
      getMatchAt,
      indexOfMatch,
    }),
    [snapshot, getMatchAt, indexOfMatch],
  );
}
