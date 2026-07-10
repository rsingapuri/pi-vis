import { describe, expect, it } from "vitest";
import { buildDiffModel } from "./diff-model.js";
import {
  type DiffSearchWorkerResponse,
  decodePackedMatch,
  findPackedMatchIndex,
  packSearchMatches,
  packedMatchCount,
} from "./diff-search-protocol.js";
import { DiffSearchWorkerClient } from "./diff-search-worker-client.js";
import { computeMatches } from "./search.js";

function request() {
  return {
    generation: 7,
    path: "f.ts",
    fileOrdinal: 0,
    query: "needle",
    caseSensitive: true,
    viewMode: "unified" as const,
    gapState: [],
    source: { kind: "texts" as const, oldText: "", newText: "needle here\n" },
  };
}

describe("packed diff-search matches", () => {
  it("round-trips and supports random lookup", () => {
    const model = buildDiffModel("old needle\n", "new needle\n");
    if (model.kind !== "ok") throw new Error("expected model");
    const matches = computeMatches(
      [{ path: "f.ts", model, gapState: [], viewMode: "split" }],
      "needle",
      true,
    );
    const data = new Int32Array(packSearchMatches(matches));
    expect(packedMatchCount(data)).toBe(2);
    expect(decodePackedMatch(data, 0, "f.ts")).toMatchObject(matches[0]!);
    expect(decodePackedMatch(data, 1, "f.ts")).toMatchObject(matches[1]!);
    expect(findPackedMatchIndex(data, matches[1]!)).toBe(1);
  });
});

describe("DiffSearchWorkerClient fallback", () => {
  it("uses the same engine when Worker is unavailable", async () => {
    const client = new DiffSearchWorkerClient(() => {
      throw new Error("Worker unavailable");
    });
    const response = await client.search(request());
    expect(response.status).toBe("ok");
    const match = decodePackedMatch(new Int32Array(response.matches), 0, "f.ts");
    expect(match).toMatchObject({ path: "f.ts", side: "new", start: 0, end: 6 });
    client.dispose();
  });

  it("rejects pending compatibility work when disposed", async () => {
    const client = new DiffSearchWorkerClient(() => {
      throw new Error("Worker unavailable");
    });
    const pending = client.search(request());
    client.dispose();
    await expect(pending).rejects.toThrow("disposed");
  });

  it("replays pending work through the fallback after a worker error", async () => {
    const fake = {
      onmessage: null as ((event: MessageEvent<DiffSearchWorkerResponse>) => void) | null,
      onerror: null as ((event: ErrorEvent) => void) | null,
      postMessage: () => {},
      terminate: () => {},
    };
    const client = new DiffSearchWorkerClient(() => fake);
    const pending = client.search(request());
    fake.onerror?.({ message: "boom" } as ErrorEvent);
    const response = await pending;
    expect(response.status).toBe("ok");
    expect(decodePackedMatch(new Int32Array(response.matches), 0, "f.ts")).toMatchObject({
      side: "new",
    });
    client.dispose();
  });

  it("rejects a pending worker request on dispose", async () => {
    const fake = {
      onmessage: null as ((event: MessageEvent<DiffSearchWorkerResponse>) => void) | null,
      onerror: null as ((event: ErrorEvent) => void) | null,
      postMessage: () => {},
      terminate: () => {},
    };
    const client = new DiffSearchWorkerClient(() => fake);
    const pending = client.search(request());
    client.dispose();
    await expect(pending).rejects.toThrow("disposed");
  });
});
