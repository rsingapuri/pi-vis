import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SessionId } from "@shared/ids.js";
import type { SearchId, SearchTargetId, SessionSearchBatch } from "@shared/session-search.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type ResolvedContextTarget, validateExactTarget } from "./context-loader.js";
import { type CatalogSource, SessionCatalog } from "./session-catalog.js";
import {
  FULL_RECONCILE_WHILE_OPEN_MS,
  type SearchRenderer,
  SessionSearchService,
  isFullSessionSearchReconcileDue,
} from "./session-search-service.js";
import type {
  SearchWorkerMatch,
  SearchWorkerResponse,
  SearchWorkerSource,
} from "./worker-protocol.js";

const roots: string[] = [];
const services: SessionSearchService[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(services.splice(0).map((service) => service.stop()));
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

class Renderer extends EventEmitter implements SearchRenderer {
  readonly batches: SessionSearchBatch[] = [];
  destroyed = false;
  constructor(readonly id: number) {
    super();
  }
  isDestroyed(): boolean {
    return this.destroyed;
  }
  send(_channel: "sessionSearch.batch", batch: SessionSearchBatch): void {
    this.batches.push(batch);
  }
}

class FakeIndex {
  revision = 1;
  sources: SearchWorkerSource[] = [];
  deferredQuery: Promise<SearchWorkerResponse> | null = null;
  match: SearchWorkerMatch | null = null;
  initialize = vi.fn(
    async (directory: string): Promise<SearchWorkerResponse> => ({
      id: 1,
      ok: true,
      type: "initialized",
      revision: this.revision,
      coverage: { indexedSources: 0, totalSources: 0, skippedSources: 0 },
    }),
  );
  reconcile = vi.fn(
    async (
      sources: SearchWorkerSource[],
      _completeCatalog = true,
    ): Promise<SearchWorkerResponse> => {
      this.sources = sources;
      return {
        id: 2,
        ok: true,
        type: "reconciled",
        revision: ++this.revision,
        coverage: {
          indexedSources: sources.length,
          totalSources: sources.length,
          skippedSources: 0,
        },
      };
    },
  );
  validate = vi.fn(
    async (
      _source?: CatalogSource,
      _target?: ResolvedContextTarget,
      _descriptor?: number,
    ): Promise<SearchWorkerResponse> => ({
      id: 7,
      ok: true,
      type: "validate",
      valid: true,
    }),
  );
  context = vi.fn(
    async (): Promise<SearchWorkerResponse> => ({
      id: 6,
      ok: true,
      type: "context",
      result: { outcome: "unavailable", message: "not used by this fixture" },
    }),
  );
  query = vi.fn(
    async (
      _workspacePath: string,
      _query: string,
      _offset: number,
    ): Promise<SearchWorkerResponse> => {
      if (this.deferredQuery) return this.deferredQuery;
      return {
        id: 3,
        ok: true,
        type: "query",
        revision: this.revision,
        matches: this.match ? [this.match] : [],
        total: this.match ? 1 : 0,
        truncated: false,
        coverage: {
          indexedSources: this.sources.length,
          totalSources: this.sources.length,
          skippedSources: 0,
        },
      };
    },
  );
  status = vi.fn(
    async (): Promise<SearchWorkerResponse> => ({
      id: 4,
      ok: true,
      type: "status",
      revision: this.revision,
      coverage: {
        indexedSources: this.sources.length,
        totalSources: this.sources.length,
        skippedSources: 0,
      },
    }),
  );
  rebuild = vi.fn(
    async (sources: SearchWorkerSource[]): Promise<SearchWorkerResponse> => ({
      id: 5,
      ok: true,
      type: "rebuilt",
      revision: ++this.revision,
      coverage: { indexedSources: sources.length, totalSources: sources.length, skippedSources: 0 },
    }),
  );
  stop = vi.fn(async () => {});
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pivis-search-service-"));
  roots.push(root);
  const workspace = path.join(root, "workspace");
  const bucket = path.join(root, "sessions", "bucket");
  const file = path.join(bucket, "session-a.jsonl");
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(bucket, { recursive: true });
  const header = { type: "session", version: 3, id: "session-a", timestamp: 1, cwd: workspace };
  const entry = {
    type: "message",
    id: "entry-a",
    timestamp: 2,
    message: { role: "user", content: "exact lifecycle" },
  };
  fs.writeFileSync(file, `${JSON.stringify(header)}\n${JSON.stringify(entry)}\n`);
  const stat = fs.statSync(file);
  const prefix = createHash("sha256").update(fs.readFileSync(file).subarray(0, 4096)).digest("hex");
  const revision = `${stat.size}:${stat.mtimeMs}:${stat.dev}:${stat.ino}:${prefix}`;
  return { root, workspace, file, revision };
}

function request(workspacePath: string, clientQueryId = "client-1") {
  return {
    rendererGeneration: 7,
    clientQueryId,
    workspacePath,
    query: "lifecycle",
    pageSize: 20,
  };
}

function fakeMatch(
  data: ReturnType<typeof fixture>,
  entryId: string,
  snippet = entryId,
): SearchWorkerMatch {
  return {
    sourcePath: data.file,
    sourceRevision: data.revision,
    workspacePath: data.workspace,
    sessionId: "session-a",
    sessionName: "Session A",
    entryOrdinal: 2,
    byteStart: 1,
    byteEnd: 2,
    entryId,
    contentPartKey: "text",
    occurrence: 0,
    contentDigest: createHash("sha256").update(snippet).digest("hex"),
    role: "user",
    timestamp: 2,
    snippet,
    matchRanges: [{ start: 0, end: Math.min(5, snippet.length) }],
    sourceMatchRanges: [{ start: 0, end: Math.min(5, snippet.length) }],
    latestPersistedPath: true,
    additionalMatches: 0,
    score: 900,
  };
}

describe("SessionSearchService", () => {
  it("spaces periodic full reconciliation from the last completed scan", () => {
    const completedAt = 10_000;
    expect(isFullSessionSearchReconcileDue(completedAt, completedAt + 29_999)).toBe(false);
    expect(
      isFullSessionSearchReconcileDue(completedAt, completedAt + FULL_RECONCILE_WHILE_OPEN_MS),
    ).toBe(true);
    expect(isFullSessionSearchReconcileDue(0, completedAt)).toBe(true);
  });

  it("records a successful explicit rebuild for ambient full-scan throttling", async () => {
    const data = fixture();
    const settings = {
      workspaceOrder: [data.workspace],
      worktrees: {},
      archivedSessions: [],
      pinnedSessions: [],
    };
    const index = new FakeIndex();
    const service = new SessionSearchService({
      databaseDirectory: path.join(data.root, "index"),
      getSettings: () => settings,
      openValidatedSource: vi.fn(),
      catalog: new SessionCatalog({
        sessionsRoot: path.join(data.root, "sessions"),
        getSettings: () => settings,
      }),
      index,
    });
    services.push(service);
    await service.initialize();
    await vi.waitFor(async () =>
      expect(
        (
          await service.status(new Renderer(30), {
            rendererGeneration: 7,
            workspacePath: data.workspace,
          })
        ).state,
      ).toBe("ready"),
    );
    const now = vi.spyOn(Date, "now").mockReturnValue(100_000);
    const renderer = new Renderer(31);

    await service.rebuild(renderer, {
      rendererGeneration: 7,
      workspacePath: data.workspace,
    });
    index.reconcile.mockClear();
    service.start(renderer, request(data.workspace));
    service.onAppFocus();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(index.reconcile).not.toHaveBeenCalled();

    now.mockReturnValue(100_000 + FULL_RECONCILE_WHILE_OPEN_MS);
    service.onAppFocus();
    await vi.waitFor(() => expect(index.reconcile).toHaveBeenCalledTimes(1));
    now.mockRestore();
  });

  it("does not throttle ambient recovery after a failed explicit rebuild", async () => {
    const data = fixture();
    const settings = {
      workspaceOrder: [data.workspace],
      worktrees: {},
      archivedSessions: [],
      pinnedSessions: [],
    };
    const index = new FakeIndex();
    const service = new SessionSearchService({
      databaseDirectory: path.join(data.root, "index"),
      getSettings: () => settings,
      openValidatedSource: vi.fn(),
      catalog: new SessionCatalog({
        sessionsRoot: path.join(data.root, "sessions"),
        getSettings: () => settings,
      }),
      index,
    });
    services.push(service);
    await service.initialize();
    await vi.waitFor(() => expect(index.reconcile).toHaveBeenCalled());
    const overdue = Date.now() + FULL_RECONCILE_WHILE_OPEN_MS + 1_000;
    const now = vi.spyOn(Date, "now").mockReturnValue(overdue);
    index.rebuild.mockRejectedValueOnce(new Error("rebuild failed"));

    await service.rebuild(new Renderer(32), {
      rendererGeneration: 7,
      workspacePath: data.workspace,
    });
    index.reconcile.mockClear();
    service.onAppFocus();

    await vi.waitFor(() => expect(index.reconcile).toHaveBeenCalledTimes(1));
    now.mockRestore();
  });

  it("fences renderer capabilities and calls explicit open exactly once", async () => {
    const data = fixture();
    const settings = {
      workspaceOrder: [data.workspace],
      worktrees: {},
      archivedSessions: [],
      pinnedSessions: [],
    };
    const catalog = new SessionCatalog({
      sessionsRoot: path.join(data.root, "sessions"),
      getSettings: () => settings,
    });
    const index = new FakeIndex();
    index.match = {
      sourcePath: data.file,
      sourceRevision: data.revision,
      workspacePath: data.workspace,
      sessionId: "session-a",
      sessionName: "Session A",
      entryOrdinal: 2,
      byteStart: 1,
      byteEnd: 2,
      entryId: "entry-a",
      contentPartKey: "text",
      occurrence: 0,
      contentDigest: createHash("sha256").update("exact lifecycle").digest("hex"),
      role: "user",
      timestamp: 2,
      snippet: "exact lifecycle",
      matchRanges: [{ start: 6, end: 15 }],
      sourceMatchRanges: [{ start: 6, end: 15 }],
      latestPersistedPath: true,
      additionalMatches: 0,
      score: 900,
    };
    const openValidatedSource = vi.fn(async (_source, _workspacePath, descriptor: number) => {
      expect(fs.fstatSync(descriptor).isFile()).toBe(true);
      fs.closeSync(descriptor);
      return {
        outcome: "opened" as const,
        sessionId: "opened-session" as SessionId,
        sessionFile: data.file,
        workspacePath: data.workspace,
        name: "Session A",
        preview: "exact lifecycle",
        sessionStatus: "cold" as const,
      };
    });
    const service = new SessionSearchService({
      databaseDirectory: path.join(data.root, "index"),
      getSettings: () => settings,
      openValidatedSource,
      catalog,
      index,
    });
    services.push(service);
    await service.initialize();
    await vi.waitFor(() => expect(index.reconcile).toHaveBeenCalled());

    const owner = new Renderer(1);
    const other = new Renderer(2);
    const { searchId } = service.start(owner, request(data.workspace));
    await vi.waitFor(() => expect(owner.batches.length).toBeGreaterThan(0));
    const result = owner.batches.at(-1)?.results[0];
    expect(result?.targetId).toBeTruthy();

    const forbidden = await service.context(other, {
      rendererGeneration: 7,
      searchId,
      targetId: result!.targetId,
      indexRevision: owner.batches.at(-1)!.indexRevision,
      before: 2,
      after: 2,
    });
    expect(forbidden.outcome).toBe("forbidden");
    expect(openValidatedSource).not.toHaveBeenCalled();
    await expect(
      service.expand(other, {
        rendererGeneration: 7,
        searchId,
        targetId: result!.targetId,
      }),
    ).resolves.toEqual({ accepted: false });
    await expect(
      service.expand(owner, {
        rendererGeneration: 7,
        searchId,
        targetId: result!.targetId,
      }),
    ).resolves.toEqual({ accepted: true });
    const expandedQuery = index.query.mock.calls.at(-1) as unknown[] | undefined;
    expect(expandedQuery?.slice(0, 6)).toEqual([
      data.workspace,
      "lifecycle",
      0,
      20,
      [],
      [data.file],
    ]);
    expect(expandedQuery?.[6]).toContain(fs.realpathSync(data.file));

    const opened = await service.open(owner, {
      rendererGeneration: 7,
      targetId: result!.targetId,
    });
    expect(opened.outcome).toBe("opened");
    expect(openValidatedSource).toHaveBeenCalledTimes(1);

    fs.appendFileSync(
      data.file,
      `${JSON.stringify({ type: "message", id: "changed", message: { role: "user", content: "changed" } })}\n`,
    );
    index.validate.mockResolvedValueOnce({ id: 8, ok: true, type: "validate", valid: false });
    await expect(
      service.open(owner, { rendererGeneration: 7, targetId: result!.targetId }),
    ).resolves.toMatchObject({ outcome: "invalid-target" });
    expect(openValidatedSource).toHaveBeenCalledTimes(1);
  });

  it("keeps exact validation and runtime opening bound to one descriptor", async () => {
    const data = fixture();
    const settings = {
      workspaceOrder: [data.workspace],
      worktrees: {},
      archivedSessions: [],
      pinnedSessions: [],
    };
    const catalog = new SessionCatalog({
      sessionsRoot: path.join(data.root, "sessions"),
      getSettings: () => settings,
    });
    const index = new FakeIndex();
    index.match = {
      sourcePath: data.file,
      sourceRevision: data.revision,
      workspacePath: data.workspace,
      sessionId: "session-a",
      sessionName: "Session A",
      entryOrdinal: 2,
      byteStart: 1,
      byteEnd: 2,
      entryId: "entry-a",
      contentPartKey: "text",
      occurrence: 0,
      contentDigest: createHash("sha256").update("exact lifecycle").digest("hex"),
      role: "user",
      timestamp: 2,
      snippet: "exact lifecycle",
      matchRanges: [{ start: 6, end: 15 }],
      sourceMatchRanges: [{ start: 6, end: 15 }],
      latestPersistedPath: true,
      additionalMatches: 0,
      score: 900,
    };
    const pinnedPath = `${data.file}.pinned`;
    let pinnedInode = 0;
    index.validate.mockImplementationOnce(async (_source, _target, descriptor?: number) => {
      expect(descriptor).toBeTypeOf("number");
      pinnedInode = fs.fstatSync(descriptor!).ino;
      fs.renameSync(data.file, pinnedPath);
      fs.writeFileSync(
        data.file,
        `${JSON.stringify({ type: "session", version: 3, id: "replacement", timestamp: 1, cwd: data.workspace })}\n`,
      );
      expect(fs.fstatSync(descriptor!).ino).toBe(pinnedInode);
      expect(fs.statSync(data.file).ino).not.toBe(pinnedInode);
      return { id: 7, ok: true, type: "validate", valid: true };
    });
    const openValidatedSource = vi.fn(async (_source, _workspacePath, descriptor: number) => {
      expect(fs.fstatSync(descriptor).ino).toBe(pinnedInode);
      expect(fs.readFileSync(descriptor, "utf8")).toContain("exact lifecycle");
      fs.closeSync(descriptor);
      return {
        outcome: "opened" as const,
        sessionId: "descriptor-session" as SessionId,
        sessionFile: data.file,
        workspacePath: data.workspace,
        name: "Session A",
        preview: null,
        sessionStatus: "cold" as const,
      };
    });
    const service = new SessionSearchService({
      databaseDirectory: path.join(data.root, "index"),
      getSettings: () => settings,
      openValidatedSource,
      catalog,
      index,
    });
    services.push(service);
    await service.initialize();
    await vi.waitFor(() => expect(index.reconcile).toHaveBeenCalled());
    const renderer = new Renderer(8);
    service.start(renderer, request(data.workspace));
    await vi.waitFor(() => expect(renderer.batches.at(-1)?.results).toHaveLength(1));

    await expect(
      service.open(renderer, {
        rendererGeneration: 7,
        targetId: renderer.batches.at(-1)!.results[0]!.targetId,
      }),
    ).resolves.toMatchObject({ outcome: "opened" });
    expect(openValidatedSource).toHaveBeenCalledOnce();
  });

  it("restarts pagination when progressive indexing invalidates its offset revision", async () => {
    const data = fixture();
    const settings = {
      workspaceOrder: [data.workspace],
      worktrees: {},
      archivedSessions: [],
      pinnedSessions: [] as string[],
    };
    const catalog = new SessionCatalog({
      sessionsRoot: path.join(data.root, "sessions"),
      getSettings: () => settings,
    });
    const index = new FakeIndex();
    const service = new SessionSearchService({
      databaseDirectory: path.join(data.root, "index"),
      getSettings: () => settings,
      openValidatedSource: vi.fn(),
      catalog,
      index,
    });
    services.push(service);
    await service.initialize();
    await vi.waitFor(async () =>
      expect(
        (
          await service.status(new Renderer(99), {
            rendererGeneration: 7,
            workspacePath: data.workspace,
          })
        ).state,
      ).toBe("ready"),
    );
    const initialRevision = index.revision;
    let mutated = false;
    index.query.mockImplementation(async (_workspace, _query, offset) => {
      const shifted = mutated && offset > 0;
      return {
        id: shifted ? 31 : 32,
        ok: true,
        type: "query",
        revision: mutated ? initialRevision + 1 : initialRevision,
        matches: shifted
          ? [fakeMatch(data, "shifted-page", "stale shifted page")]
          : [
              mutated
                ? fakeMatch(data, "replacement-page", "refreshed first page")
                : fakeMatch(data, "first-page", "original first page"),
            ],
        total: 3,
        truncated: false,
        coverage: { indexedSources: 1, totalSources: 1, skippedSources: 0 },
      };
    });
    index.query.mockClear();
    const reconcilesBeforeStart = index.reconcile.mock.calls.length;
    const renderer = new Renderer(20);
    const { searchId } = service.start(renderer, request(data.workspace));
    await vi.waitFor(() => expect(renderer.batches).toHaveLength(1));
    expect(index.reconcile).toHaveBeenCalledTimes(reconcilesBeforeStart);

    mutated = true;
    index.query.mockClear();
    await expect(service.more(renderer, { rendererGeneration: 7, searchId })).resolves.toEqual({
      accepted: true,
    });

    expect(index.query.mock.calls.map((call) => call[2])).toEqual([1, 0]);
    expect(renderer.batches.at(-1)).toMatchObject({
      disposition: "replace",
      results: [{ snippet: "refreshed first page" }],
    });

    // Pinning is a ranking input outside SQLite. It invalidates the cursor even
    // when the worker revision itself remains unchanged.
    settings.pinnedSessions = [data.file];
    index.query.mockClear();
    await service.more(renderer, { rendererGeneration: 7, searchId });
    expect(index.query.mock.calls.map((call) => call[2])).toEqual([1, 0]);
    expect(renderer.batches.at(-1)?.disposition).toBe("replace");
  });

  it("rejects a copied target when the post-catalog descriptor header changes ownership", async () => {
    const data = fixture();
    const settings = {
      workspaceOrder: [data.workspace],
      worktrees: {},
      archivedSessions: [],
      pinnedSessions: [],
    };
    const catalog = new SessionCatalog({
      sessionsRoot: path.join(data.root, "sessions"),
      getSettings: () => settings,
    });
    const index = new FakeIndex();
    const text = fs.readFileSync(data.file, "utf8");
    const [headerLine, entryLine] = text.trimEnd().split("\n") as [string, string];
    index.match = {
      sourcePath: data.file,
      sourceRevision: data.revision,
      workspacePath: data.workspace,
      sessionId: "session-a",
      sessionName: "Session A",
      entryOrdinal: 2,
      byteStart: Buffer.byteLength(`${headerLine}\n`),
      byteEnd: Buffer.byteLength(`${headerLine}\n${entryLine}`),
      entryId: "entry-a",
      contentPartKey: "text",
      occurrence: 0,
      contentDigest: createHash("sha256").update("exact lifecycle").digest("hex"),
      role: "user",
      timestamp: 2,
      snippet: "exact lifecycle",
      matchRanges: [{ start: 6, end: 15 }],
      sourceMatchRanges: [{ start: 6, end: 15 }],
      latestPersistedPath: true,
      additionalMatches: 0,
      score: 900,
    };
    index.validate.mockImplementation(async (source, target, descriptor) => ({
      id: 7,
      ok: true,
      type: "validate",
      valid:
        !!source && !!target && descriptor !== undefined
          ? await validateExactTarget(source, target, descriptor)
          : false,
    }));
    const originalRevalidate = catalog.revalidate.bind(catalog);
    let replaceAfterInspection = true;
    vi.spyOn(catalog, "revalidate").mockImplementation(async (...args) => {
      const source = await originalRevalidate(...args);
      if (source && replaceAfterInspection) {
        replaceAfterInspection = false;
        const changedHeader = headerLine
          .replace('"id":"session-a"', '"id":"session-b"')
          .replace(data.workspace, `${data.workspace.slice(0, -1)}x`);
        fs.writeFileSync(data.file, `${changedHeader}\n${entryLine}\n`);
      }
      return source;
    });
    const openValidatedSource = vi.fn();
    const service = new SessionSearchService({
      databaseDirectory: path.join(data.root, "index"),
      getSettings: () => settings,
      openValidatedSource,
      catalog,
      index,
    });
    services.push(service);
    await service.initialize();
    await vi.waitFor(() => expect(index.reconcile).toHaveBeenCalled());
    const renderer = new Renderer(10);
    service.start(renderer, request(data.workspace));
    await vi.waitFor(() => expect(renderer.batches.at(-1)?.results).toHaveLength(1));

    await expect(
      service.open(renderer, {
        rendererGeneration: 7,
        targetId: renderer.batches.at(-1)!.results[0]!.targetId,
      }),
    ).resolves.toMatchObject({ outcome: "invalid-target" });
    expect(openValidatedSource).not.toHaveBeenCalled();
  });

  it("promotes a workspace when search starts after startup discovery but during bulk indexing", async () => {
    const data = fixture();
    const settings = {
      workspaceOrder: [data.workspace],
      worktrees: {},
      archivedSessions: [],
      pinnedSessions: [],
    };
    const index = new FakeIndex();
    let releaseFull!: () => void;
    const fullBlocked = new Promise<void>((resolve) => {
      releaseFull = resolve;
    });
    index.reconcile.mockImplementation(async (sources, completeCatalog = true) => {
      index.sources = sources;
      if (completeCatalog) await fullBlocked;
      return {
        id: 2,
        ok: true,
        type: "reconciled",
        revision: ++index.revision,
        coverage: {
          indexedSources: sources.length,
          totalSources: sources.length,
          skippedSources: 0,
        },
      };
    });
    const service = new SessionSearchService({
      databaseDirectory: path.join(data.root, "index"),
      getSettings: () => settings,
      openValidatedSource: vi.fn(),
      catalog: new SessionCatalog({
        sessionsRoot: path.join(data.root, "sessions"),
        getSettings: () => settings,
      }),
      index,
    });
    services.push(service);
    await service.initialize();
    await vi.waitFor(() =>
      expect(index.reconcile.mock.calls.some((call) => call[1] === true)).toBe(true),
    );

    service.start(new Renderer(21), request(data.workspace));

    await vi.waitFor(() =>
      expect(
        index.reconcile.mock.calls.some(
          ([sources, complete]) =>
            complete === false && sources.some((source) => source.workspacePath === data.workspace),
        ),
      ).toBe(true),
    );
    releaseFull();
  });

  it("promotes a known-source append while full reconciliation is still running", async () => {
    const data = fixture();
    const settings = {
      workspaceOrder: [data.workspace],
      worktrees: {},
      archivedSessions: [],
      pinnedSessions: [],
    };
    const index = new FakeIndex();
    const initialSize = fs.statSync(data.file).size;
    let releaseFull!: () => void;
    const fullBlocked = new Promise<void>((resolve) => {
      releaseFull = resolve;
    });
    index.reconcile.mockImplementation(async (sources, completeCatalog = true) => {
      index.sources = sources;
      if (completeCatalog) await fullBlocked;
      return {
        id: 2,
        ok: true,
        type: "reconciled",
        revision: ++index.revision,
        coverage: {
          indexedSources: sources.length,
          totalSources: sources.length,
          skippedSources: 0,
        },
      };
    });
    const service = new SessionSearchService({
      databaseDirectory: path.join(data.root, "index"),
      getSettings: () => settings,
      openValidatedSource: vi.fn(),
      catalog: new SessionCatalog({
        sessionsRoot: path.join(data.root, "sessions"),
        getSettings: () => settings,
      }),
      index,
    });
    services.push(service);
    service.start(new Renderer(9), request(data.workspace));
    await service.initialize();
    await vi.waitFor(() =>
      expect(index.reconcile.mock.calls.some((call) => call[1] === true)).toBe(true),
    );

    fs.appendFileSync(
      data.file,
      `${JSON.stringify({ type: "message", id: "during-full", message: { role: "user", content: "fresh" } })}\n`,
    );
    await vi.waitFor(
      () =>
        expect(
          index.reconcile.mock.calls.some(
            ([sources, complete]) =>
              complete === false && sources.some((source) => source.size > initialSize),
          ),
        ).toBe(true),
      { timeout: 2_000 },
    );
    releaseFull();
  });

  it("keeps initialization retryable after a transient worker failure", async () => {
    const data = fixture();
    const settings = {
      workspaceOrder: [data.workspace],
      worktrees: {},
      archivedSessions: [],
      pinnedSessions: [],
    };
    const index = new FakeIndex();
    index.initialize.mockRejectedValueOnce(new Error("worker startup failed"));
    const service = new SessionSearchService({
      databaseDirectory: path.join(data.root, "index"),
      getSettings: () => settings,
      openValidatedSource: vi.fn(),
      catalog: new SessionCatalog({
        sessionsRoot: path.join(data.root, "sessions"),
        getSettings: () => settings,
      }),
      index,
    });
    services.push(service);

    await service.initialize();
    expect(index.initialize).toHaveBeenCalledTimes(1);
    await service.initialize();
    await vi.waitFor(() => expect(index.reconcile).toHaveBeenCalled());
    expect(index.initialize).toHaveBeenCalledTimes(2);
  });

  it("suppresses a late query after cancellation and removed workspace", async () => {
    const data = fixture();
    const settings = {
      workspaceOrder: [data.workspace],
      worktrees: {},
      archivedSessions: [],
      pinnedSessions: [],
    };
    const catalog = new SessionCatalog({
      sessionsRoot: path.join(data.root, "sessions"),
      getSettings: () => settings,
    });
    const index = new FakeIndex();
    let resolveQuery!: (response: SearchWorkerResponse) => void;
    index.deferredQuery = new Promise((resolve) => {
      resolveQuery = resolve;
    });
    const service = new SessionSearchService({
      databaseDirectory: path.join(data.root, "index"),
      getSettings: () => settings,
      openValidatedSource: vi.fn(),
      catalog,
      index,
    });
    services.push(service);
    await service.initialize();
    const renderer = new Renderer(3);
    const { searchId } = service.start(renderer, request(data.workspace));
    await vi.waitFor(() => expect(index.query).toHaveBeenCalled());
    expect(
      service.cancel(renderer, { rendererGeneration: 7, searchId: searchId as SearchId }),
    ).toEqual({ cancelled: true });
    settings.workspaceOrder.splice(0);
    resolveQuery({
      id: 9,
      ok: true,
      type: "query",
      revision: 1,
      matches: [],
      total: 0,
      truncated: false,
      coverage: { indexedSources: 1, totalSources: 1, skippedSources: 0 },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(renderer.batches).toEqual([]);
    expect(
      await service.open(renderer, {
        rendererGeneration: 7,
        targetId: "invalid-target-capability" as SearchTargetId,
      }),
    ).toMatchObject({ outcome: "invalid-target" });
  });

  it("retires a search when its renderer closes during batch delivery", async () => {
    const data = fixture();
    const settings = {
      workspaceOrder: [data.workspace],
      worktrees: {},
      archivedSessions: [],
      pinnedSessions: [],
    };
    const index = new FakeIndex();
    const service = new SessionSearchService({
      databaseDirectory: path.join(data.root, "index"),
      getSettings: () => settings,
      openValidatedSource: vi.fn(),
      catalog: new SessionCatalog({
        sessionsRoot: path.join(data.root, "sessions"),
        getSettings: () => settings,
      }),
      index,
    });
    services.push(service);
    await service.initialize();
    const renderer = new Renderer(4);
    const send = vi.spyOn(renderer, "send").mockImplementation(() => {
      throw new Error("Render frame was disposed before WebFrameMain could be accessed");
    });

    const { searchId } = service.start(renderer, request(data.workspace));
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(
      service.cancel(renderer, { rendererGeneration: 7, searchId: searchId as SearchId }),
    ).toEqual({ cancelled: false });
  });

  it("keeps query/context modules independent of SessionRegistry", () => {
    for (const file of ["session-search-service.ts", "context-loader.ts", "index-worker.ts"]) {
      const source = fs.readFileSync(path.join(__dirname, file), "utf8");
      expect(source).not.toMatch(/(?:from .*session-registry|import .*SessionRegistry)/u);
    }
  });
});
