import { createHash, randomUUID } from "node:crypto";
import { closeSync } from "node:fs";
import { setImmediate as deferImmediate } from "node:timers";
import { setTimeout as delay } from "node:timers/promises";
import type {
  SearchId,
  SearchTargetId,
  SessionSearchBatch,
  SessionSearchContextResult,
  SessionSearchIndexStatus,
  SessionSearchOpenResult,
  SessionSearchResult,
} from "@shared/session-search.js";
import {
  SEARCH_BATCH_MAX_BYTES,
  SessionSearchCancelRequestSchema,
  SessionSearchContextRequestSchema,
  SessionSearchExpandRequestSchema,
  SessionSearchMoreRequestSchema,
  SessionSearchOpenRequestSchema,
  SessionSearchRebuildRequestSchema,
  SessionSearchStartRequestSchema,
  SessionSearchStatusRequestSchema,
} from "@shared/session-search.js";
import type { AppSettings } from "@shared/settings.js";
import type {
  ContextLoadOptions,
  ContextLoadResult,
  ResolvedContextTarget,
} from "./context-loader.js";
import { openConfinedRegularFile } from "./entry-extractor.js";
import { SessionSearchIndexClient } from "./index-client.js";
import { type CatalogSource, SessionCatalog } from "./session-catalog.js";
import type {
  SearchWorkerMatch,
  SearchWorkerResponse,
  SearchWorkerSource,
} from "./worker-protocol.js";

const APPEND_RECONCILE_WHILE_OPEN_MS = 250;
export const FULL_RECONCILE_WHILE_OPEN_MS = 30_000;

export function isFullSessionSearchReconcileDue(
  lastCompletedAt: number,
  now = Date.now(),
): boolean {
  return lastCompletedAt === 0 || now - lastCompletedAt >= FULL_RECONCILE_WHILE_OPEN_MS;
}
const MAX_TARGETS = 5_000;

export interface SearchRenderer {
  id: number;
  isDestroyed(): boolean;
  send(channel: "sessionSearch.batch", batch: SessionSearchBatch): void;
  once?(event: "destroyed", listener: () => void): void;
}

interface SearchIndex {
  initialize(databaseDirectory: string): Promise<SearchWorkerResponse>;
  reconcile(
    sources: SearchWorkerSource[],
    completeCatalog?: boolean,
  ): Promise<SearchWorkerResponse>;
  context(
    source: CatalogSource,
    target: ResolvedContextTarget,
    options: ContextLoadOptions,
    sourceDescriptor?: number,
  ): Promise<SearchWorkerResponse>;
  validate(
    source: CatalogSource,
    target: ResolvedContextTarget,
    sourceDescriptor?: number,
  ): Promise<SearchWorkerResponse>;
  query(
    workspacePath: string,
    query: string,
    offset: number,
    limit: number,
    pinnedSourcePaths: string[],
    expandedSourcePaths: string[],
    allowedSourcePaths: string[],
  ): Promise<SearchWorkerResponse>;
  status(workspacePath?: string): Promise<SearchWorkerResponse>;
  rebuild(sources: SearchWorkerSource[]): Promise<SearchWorkerResponse>;
  stop(): Promise<void>;
}

interface SearchState {
  searchId: SearchId;
  owner: SearchRenderer;
  rendererGeneration: number;
  clientQueryId: string;
  workspacePath: string;
  query: string;
  pageSize: number;
  sequence: number;
  nextOffset: number;
  runToken: number;
  contextRunToken: number;
  contextTail: Promise<void>;
  /** Coalesces progressive refresh polling to one worker query per search. */
  pageInFlight: Promise<void> | null;
  /** Index snapshot that owns nextOffset; revision changes restart at page 1. */
  pageRevision: number | null;
  /** Ranking/filter inputs outside SQLite that also own nextOffset. */
  pageViewFingerprint: string | null;
  cancelled: boolean;
  targetIdsByKey: Map<string, SearchTargetId>;
  /** Source paths enter this set only after resolving an owned opaque target. */
  expandedSourcePaths: Set<string>;
}

interface TargetRecord extends ResolvedContextTarget {
  targetId: SearchTargetId;
  ownerId: number;
  rendererGeneration: number;
  searchId: SearchId;
  workspacePath: string;
  indexRevision: number;
  sourcePath: string;
}

export interface SessionSearchServiceOptions {
  databaseDirectory: string;
  getSettings: () => Pick<
    AppSettings,
    "workspaceOrder" | "worktrees" | "archivedSessions" | "pinnedSessions"
  >;
  /** Takes ownership of the descriptor, including on error. */
  openValidatedSource: (
    source: CatalogSource,
    workspacePath: string,
    descriptor: number,
  ) => Promise<SessionSearchOpenResult>;
  catalog?: SessionCatalog;
  index?: SearchIndex;
}

/**
 * Main-process authority for local saved-history search.
 *
 * Query/context paths have no SessionRegistry dependency. Only the injected
 * explicit-open callback may enter normal session opening; renderer activation
 * and activation-visit ownership remain in the existing session store path.
 */
export class SessionSearchService {
  private readonly catalog: SessionCatalog;
  private readonly index: SearchIndex;
  private readonly searches = new Map<SearchId, SearchState>();
  private readonly targets = new Map<SearchTargetId, TargetRecord>();
  private readonly attachedRenderers = new Set<number>();
  private readonly reconciledPaths = new Set<string>();
  private reconcilePromise: Promise<void> | null = null;
  private readonly promotedWorkspaces = new Set<string>();
  private knownReconcilePromise: Promise<void> | null = null;
  private initializePromise: Promise<void> | null = null;
  private initialized = false;
  private stopped = false;
  private indexRevision = 0;
  private readonly workerCoverageByWorkspace = new Map<
    string,
    { indexedSources: number; totalSources: number; skippedSources: number }
  >();
  private failure: string | null = null;
  private lastFullReconcileCompletedAt = 0;
  private readonly appendTimer: ReturnType<typeof setInterval>;
  private readonly fullTimer: ReturnType<typeof setInterval>;

  constructor(private readonly options: SessionSearchServiceOptions) {
    this.catalog =
      options.catalog ??
      new SessionCatalog({
        getSettings: options.getSettings,
      });
    this.index = options.index ?? new SessionSearchIndexClient();
    this.appendTimer = setInterval(() => {
      if (this.searches.size > 0) void this.reconcileKnownNow();
    }, APPEND_RECONCILE_WHILE_OPEN_MS);
    this.fullTimer = setInterval(() => {
      if (
        this.searches.size > 0 &&
        isFullSessionSearchReconcileDue(this.lastFullReconcileCompletedAt)
      ) {
        void this.reconcileNow();
      }
    }, FULL_RECONCILE_WHILE_OPEN_MS);
    this.appendTimer.unref?.();
    this.fullTimer.unref?.();
  }

  async initialize(): Promise<void> {
    if (this.initialized || this.stopped) return;
    if (this.initializePromise) return this.initializePromise;
    this.initializePromise = (async () => {
      try {
        const response = await this.index.initialize(this.options.databaseDirectory);
        this.adoptWorkerStatus(response);
        this.initialized = true;
        this.failure = null;
        void this.reconcileNow();
      } catch (error) {
        // Keep initialization retryable. A transient worker/runtime failure
        // must not permanently strand Rebuild or a later focus reconciliation.
        this.failure = error instanceof Error ? error.message : String(error);
      }
    })().finally(() => {
      this.initializePromise = null;
    });
    return this.initializePromise;
  }

  start(renderer: SearchRenderer, input: unknown): { accepted: true; searchId: SearchId } {
    const request = SessionSearchStartRequestSchema.parse(input);
    this.requireWorkspace(request.workspacePath);
    this.attachRenderer(renderer);
    for (const state of this.searches.values()) {
      if (
        state.owner.id === renderer.id &&
        (state.rendererGeneration !== request.rendererGeneration ||
          state.clientQueryId !== request.clientQueryId)
      ) {
        this.cancelState(state);
      }
    }
    const searchId = randomUUID() as SearchId;
    const state: SearchState = {
      searchId,
      owner: renderer,
      rendererGeneration: request.rendererGeneration,
      clientQueryId: request.clientQueryId,
      workspacePath: request.workspacePath,
      query: request.query,
      pageSize: request.pageSize,
      sequence: 0,
      nextOffset: 0,
      runToken: 0,
      contextRunToken: 0,
      contextTail: Promise.resolve(),
      pageInFlight: null,
      pageRevision: null,
      pageViewFingerprint: null,
      cancelled: false,
      targetIdsByKey: new Map(),
      expandedSourcePaths: new Set(),
    };
    this.searches.set(searchId, state);
    // A startup traversal may already be in flight with no active-workspace
    // hints. Promote its remaining directory queue without restarting it.
    this.catalog.prioritize(request.workspacePath);
    this.promoteWorkspaceDuringReconcile(request.workspacePath);
    // Return the capability before any event can arrive at the renderer. This
    // prevents a fast warm query from racing its sessionSearch.start response.
    deferImmediate(() => void this.runPage(state, "replace", 0));
    if (isFullSessionSearchReconcileDue(this.lastFullReconcileCompletedAt)) {
      void this.reconcileNow();
    }
    return { accepted: true, searchId };
  }

  async more(renderer: SearchRenderer, input: unknown): Promise<{ accepted: boolean }> {
    const request = SessionSearchMoreRequestSchema.parse(input);
    const state = this.searches.get(request.searchId);
    if (!this.ownsSearch(state, renderer.id, request.rendererGeneration))
      return { accepted: false };
    await state.pageInFlight;
    if (!this.ownsSearch(state, renderer.id, request.rendererGeneration)) {
      return { accepted: false };
    }
    await this.runPage(state, "append", state.nextOffset);
    return { accepted: true };
  }

  async expand(renderer: SearchRenderer, input: unknown): Promise<{ accepted: boolean }> {
    const request = SessionSearchExpandRequestSchema.parse(input);
    const state = this.searches.get(request.searchId);
    const target = this.targets.get(request.targetId);
    if (
      !this.ownsSearch(state, renderer.id, request.rendererGeneration) ||
      !target ||
      target.ownerId !== renderer.id ||
      target.rendererGeneration !== request.rendererGeneration ||
      target.searchId !== request.searchId
    ) {
      return { accepted: false };
    }
    state.expandedSourcePaths.add(target.sourcePath);
    await state.pageInFlight;
    if (!this.ownsSearch(state, renderer.id, request.rendererGeneration)) {
      return { accepted: false };
    }
    await this.runPage(state, "replace", 0);
    return { accepted: true };
  }

  cancel(renderer: SearchRenderer, input: unknown): { cancelled: boolean } {
    const request = SessionSearchCancelRequestSchema.parse(input);
    const state = this.searches.get(request.searchId);
    if (!this.ownsSearch(state, renderer.id, request.rendererGeneration))
      return { cancelled: false };
    this.cancelState(state);
    return { cancelled: true };
  }

  async context(renderer: SearchRenderer, input: unknown): Promise<SessionSearchContextResult> {
    const request = SessionSearchContextRequestSchema.parse(input);
    const state = this.searches.get(request.searchId);
    const target = this.targets.get(request.targetId);
    if (
      !this.ownsSearch(state, renderer.id, request.rendererGeneration) ||
      !target ||
      target.ownerId !== renderer.id ||
      target.rendererGeneration !== request.rendererGeneration ||
      target.searchId !== request.searchId ||
      target.indexRevision !== request.indexRevision
    ) {
      return { outcome: "forbidden", message: "This search result is no longer valid." };
    }
    if (!this.workspaceRegistered(target.workspacePath)) {
      this.cancelState(state);
      return { outcome: "forbidden", message: "The workspace is no longer registered." };
    }
    const contextRunToken = ++state.contextRunToken;
    const predecessor = state.contextTail;
    let releaseContext!: () => void;
    state.contextTail = new Promise<void>((resolve) => {
      releaseContext = resolve;
    });
    await predecessor;
    if (state.cancelled || state.contextRunToken !== contextRunToken) {
      releaseContext();
      return { outcome: "unavailable", message: "A newer preview replaced this request." };
    }
    const source = await this.catalog.revalidate(target.sourcePath, target.workspacePath);
    if (!source || source.archived) {
      releaseContext();
      return { outcome: "removed", message: "The saved session is no longer available." };
    }
    if (state.cancelled || state.contextRunToken !== contextRunToken) {
      releaseContext();
      return { outcome: "unavailable", message: "A newer preview replaced this request." };
    }
    let descriptor: number | undefined;
    try {
      // Bind workspace/header authority and context bytes to one inode. A path
      // replacement after catalog inspection cannot redirect preview.
      descriptor = openConfinedRegularFile(source.canonicalPath, source.sessionsRoot);
      const response = await this.index.context(
        source,
        target,
        {
          before: request.before,
          after: request.after,
        },
        descriptor,
      );
      if (!response.ok || response.type !== "context") {
        return { outcome: "unavailable", message: "Saved history context is unavailable." };
      }
      if (state.cancelled || state.contextRunToken !== contextRunToken) {
        return { outcome: "unavailable", message: "A newer preview replaced this request." };
      }
      const result: ContextLoadResult = response.result;
      return "items" in result ? { ...result, targetId: target.targetId } : result;
    } catch {
      return { outcome: "unavailable", message: "Saved history context is unavailable." };
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
      releaseContext();
    }
  }

  async open(renderer: SearchRenderer, input: unknown): Promise<SessionSearchOpenResult> {
    const request = SessionSearchOpenRequestSchema.parse(input);
    const target = this.targets.get(request.targetId);
    if (
      !target ||
      target.ownerId !== renderer.id ||
      target.rendererGeneration !== request.rendererGeneration
    ) {
      return { outcome: "invalid-target", message: "This search result is no longer valid." };
    }
    if (!this.workspaceRegistered(target.workspacePath)) {
      return { outcome: "forbidden", message: "The workspace is no longer registered." };
    }
    const source = await this.catalog.revalidate(target.sourcePath, target.workspacePath);
    if (!source || source.archived) {
      return { outcome: "forbidden", message: "The saved session is no longer searchable." };
    }
    let descriptor: number;
    try {
      // Acquire the inode before exact-content validation. Worker threads share
      // the process fd table, so validation and optional relocation read this
      // descriptor rather than reopening a raceable pathname.
      descriptor = openConfinedRegularFile(source.canonicalPath, source.sessionsRoot);
    } catch {
      return { outcome: "unavailable", message: "The saved session could not be opened." };
    }
    let handedOff = false;
    try {
      const exact = await this.index.validate(source, target, descriptor);
      if (!exact.ok || exact.type !== "validate") {
        return { outcome: "unavailable", message: "The saved session could not be validated." };
      }
      if (!exact.valid) {
        // A rewrite may move an otherwise identical entry. Relocation remains
        // descriptor-bound so pathname replacement cannot validate one inode
        // and hand a different inode to the runtime.
        const relocated = await this.index.context(
          source,
          target,
          { before: 0, after: 0 },
          descriptor,
        );
        if (
          !relocated.ok ||
          relocated.type !== "context" ||
          (relocated.result.outcome !== "ready" && relocated.result.outcome !== "relocated")
        ) {
          return {
            outcome: "invalid-target",
            message: "This session changed after the result was found. Refresh the result first.",
          };
        }
      }
      handedOff = true;
      return await this.options.openValidatedSource(source, target.workspacePath, descriptor);
    } catch {
      return { outcome: "unavailable", message: "The saved session could not be validated." };
    } finally {
      if (!handedOff) closeSync(descriptor);
    }
  }

  async status(renderer: SearchRenderer, input: unknown): Promise<SessionSearchIndexStatus> {
    const request = SessionSearchStatusRequestSchema.parse(input);
    this.requireWorkspace(request.workspacePath);
    this.attachRenderer(renderer);
    if (!this.initialized) await this.initialize();
    if (!this.initialized) return this.currentStatus(request.workspacePath);
    try {
      const response = await this.index.status(request.workspacePath);
      this.adoptWorkerStatus(response);
      if (response.ok && "coverage" in response) {
        this.workerCoverageByWorkspace.set(request.workspacePath, { ...response.coverage });
      }
    } catch (error) {
      this.failure = error instanceof Error ? error.message : String(error);
    }
    return this.currentStatus(request.workspacePath);
  }

  async rebuild(renderer: SearchRenderer, input: unknown): Promise<SessionSearchIndexStatus> {
    const request = SessionSearchRebuildRequestSchema.parse(input);
    this.requireWorkspace(request.workspacePath);
    this.attachRenderer(renderer);
    if (!this.initialized) await this.initialize();
    if (!this.initialized) return this.currentStatus(request.workspacePath);
    try {
      const sources = await this.refreshSources();
      const response = await this.index.rebuild(sources);
      this.adoptWorkerStatus(response);
      this.failure = null;
      this.replaceReconciledPaths(sources);
      this.recordSuccessfulFullReconciliation();
      for (const state of this.searches.values()) void this.runPage(state, "replace", 0);
    } catch (error) {
      this.failure = error instanceof Error ? error.message : String(error);
    }
    return this.currentStatus(request.workspacePath);
  }

  onRendererDestroyed(rendererId: number): void {
    for (const state of this.searches.values()) {
      if (state.owner.id === rendererId) this.cancelState(state);
    }
    for (const [targetId, target] of this.targets) {
      if (target.ownerId === rendererId) this.targets.delete(targetId);
    }
    this.attachedRenderers.delete(rendererId);
  }

  onAppFocus(): void {
    if (!this.stopped && isFullSessionSearchReconcileDue(this.lastFullReconcileCompletedAt)) {
      void this.reconcileNow();
    }
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    clearInterval(this.appendTimer);
    clearInterval(this.fullTimer);
    for (const state of [...this.searches.values()]) this.cancelState(state);
    this.targets.clear();
    await this.index.stop().catch(() => {});
  }

  private async reconcileNow(): Promise<void> {
    if (this.stopped) return;
    if (this.reconcilePromise) return this.reconcilePromise;
    if (this.knownReconcilePromise) await this.knownReconcilePromise;
    if (this.stopped || this.reconcilePromise) return this.reconcilePromise ?? undefined;
    this.promotedWorkspaces.clear();
    this.reconcilePromise = (async () => {
      try {
        if (!this.initialized) await this.initialize();
        if (!this.initialized) return;
        const sources = await this.refreshSources(async (discovered) => {
          const activeWorkspaces = new Set(
            [...this.searches.values()].map((state) => state.workspacePath),
          );
          const newlyPromotableWorkspaces = new Set(
            discovered
              .filter(
                (source) =>
                  activeWorkspaces.has(source.workspacePath) &&
                  !this.promotedWorkspaces.has(source.workspacePath),
              )
              .map((source) => source.workspacePath),
          );
          if (newlyPromotableWorkspaces.size === 0) return;
          const promotable = discovered.filter((source) =>
            newlyPromotableWorkspaces.has(source.workspacePath),
          );
          for (const workspacePath of newlyPromotableWorkspaces) {
            this.promotedWorkspaces.add(workspacePath);
          }
          await this.reconcileWorkerSources(promotable, false);
        });
        await this.reconcileWorkerSources(sources);
        this.recordSuccessfulFullReconciliation();
      } catch (error) {
        this.failure = error instanceof Error ? error.message : String(error);
      }
    })().finally(() => {
      this.reconcilePromise = null;
      this.promotedWorkspaces.clear();
    });
    return this.reconcilePromise;
  }

  private promoteWorkspaceDuringReconcile(workspacePath: string): void {
    if (!this.reconcilePromise || this.promotedWorkspaces.has(workspacePath)) return;
    const sources = this.orderSources(this.catalog.sourcesForWorkspace(workspacePath)).filter(
      (source) => !this.reconciledPaths.has(source.canonicalPath),
    );
    if (sources.length === 0) return;
    this.promotedWorkspaces.add(workspacePath);
    void this.reconcileWorkerSources(sources, false).catch((error) => {
      this.promotedWorkspaces.delete(workspacePath);
      this.failure = error instanceof Error ? error.message : String(error);
    });
  }

  private recordSuccessfulFullReconciliation(): void {
    this.lastFullReconcileCompletedAt = Date.now();
  }

  private async reconcileKnownNow(): Promise<void> {
    if (this.stopped) return;
    if (this.knownReconcilePromise) return this.knownReconcilePromise;
    this.knownReconcilePromise = (async () => {
      try {
        const refreshed = await this.catalog.refreshKnownChanges();
        if (!refreshed.changed || refreshed.changedSources.length === 0 || this.stopped) return;
        // An incomplete reconcile is a priority worker request. This promotes
        // appends from an already-indexed early source even while a large full
        // catalog reconciliation continues in the background.
        await this.reconcileWorkerSources(this.orderSources(refreshed.changedSources), false);
      } catch (error) {
        this.failure = error instanceof Error ? error.message : String(error);
      }
    })().finally(() => {
      this.knownReconcilePromise = null;
    });
    return this.knownReconcilePromise;
  }

  private async reconcileWorkerSources(
    sources: SearchWorkerSource[],
    completeCatalog = true,
  ): Promise<void> {
    let settled = false;
    const reconciliation = this.index.reconcile(sources, completeCatalog).finally(() => {
      settled = true;
    });
    // Query requests are worker-priority work. Reissue while indexing so the
    // first completed source and completed appends surface progressively.
    while (!settled && !this.stopped) {
      await Promise.race([reconciliation.then(() => undefined), delay(100)]);
      if (!settled) {
        for (const state of [...this.searches.values()]) void this.runPage(state, "replace", 0);
      }
    }
    const response = await reconciliation;
    this.adoptWorkerStatus(response);
    if (completeCatalog) this.replaceReconciledPaths(sources);
    else for (const source of sources) this.reconciledPaths.add(source.canonicalPath);
    this.failure = null;
    for (const state of [...this.searches.values()]) {
      if (!this.workspaceRegistered(state.workspacePath)) this.cancelState(state);
      else void this.rerunPageAfterCurrent(state);
    }
  }

  private async rerunPageAfterCurrent(state: SearchState): Promise<void> {
    await state.pageInFlight;
    if (state.cancelled || state.owner.isDestroyed()) return;
    await this.runPage(state, "replace", 0);
  }

  private async refreshSources(
    onPriorityDiscovered?: (sources: SearchWorkerSource[]) => Promise<void>,
  ): Promise<SearchWorkerSource[]> {
    const priorityWorkspacePaths = [...this.searches.values()].map((state) => state.workspacePath);
    const sources = await this.catalog.refresh({
      priorityWorkspacePaths,
      ...(onPriorityDiscovered
        ? {
            onDiscovered: async (discovered: readonly CatalogSource[]) =>
              onPriorityDiscovered(this.orderSources(discovered)),
          }
        : {}),
    });
    return this.orderSources(sources);
  }

  private orderSources(sources: readonly CatalogSource[]): SearchWorkerSource[] {
    const priority = new Set([...this.searches.values()].map((state) => state.workspacePath));
    const pinned = new Set(this.options.getSettings().pinnedSessions);
    return sources
      .filter((source) => source.health === "healthy" && source.workspacePath !== null)
      .sort(
        (left, right) =>
          Number(priority.has(right.workspacePath ?? "")) -
            Number(priority.has(left.workspacePath ?? "")) ||
          Number(pinned.has(right.canonicalPath)) - Number(pinned.has(left.canonicalPath)) ||
          (right.lastUserActivity ?? 0) - (left.lastUserActivity ?? 0) ||
          left.canonicalPath.localeCompare(right.canonicalPath),
      )
      .map((source) => this.toWorkerSource(source));
  }

  private toWorkerSource(source: CatalogSource): SearchWorkerSource {
    if (!source.workspacePath) throw new Error("Unowned source cannot be indexed");
    return {
      canonicalPath: source.canonicalPath,
      sessionsRoot: source.sessionsRoot,
      sessionId: source.sessionId,
      workspacePath: source.workspacePath,
      ...(source.worktree ? { worktreeName: source.worktree.name.slice(0, 512) } : {}),
      archived: source.archived,
      sessionName: (source.sessionName ?? source.sessionId).slice(0, 2_048),
      size: source.size,
      mtimeMs: source.mtimeMs,
      ...(source.device !== null ? { device: source.device } : {}),
      ...(source.inode !== null ? { inode: source.inode } : {}),
      prefixFingerprint: source.prefixFingerprint,
      sourceRevision: source.sourceRevision,
    };
  }

  private queryViewFingerprint(
    pinnedSourcePaths: readonly string[],
    expandedSourcePaths: readonly string[],
    allowedSourcePaths: readonly string[],
  ): string {
    const hash = createHash("sha256");
    for (const [kind, paths] of [
      ["pinned", pinnedSourcePaths],
      ["expanded", expandedSourcePaths],
      ["allowed", allowedSourcePaths],
    ] as const) {
      hash.update(kind);
      for (const value of paths) hash.update(`\0${Buffer.byteLength(value, "utf8")}:${value}`);
    }
    return hash.digest("hex");
  }

  private async runPage(
    state: SearchState,
    disposition: "replace" | "append",
    offset: number,
  ): Promise<void> {
    if (state.pageInFlight) return state.pageInFlight;
    const request = this.runPageOnce(state, disposition, offset);
    state.pageInFlight = request;
    try {
      await request;
    } finally {
      if (state.pageInFlight === request) state.pageInFlight = null;
    }
  }

  private async runPageOnce(
    state: SearchState,
    disposition: "replace" | "append",
    offset: number,
  ): Promise<void> {
    if (state.cancelled || state.owner.isDestroyed()) return;
    if (!this.workspaceRegistered(state.workspacePath)) {
      this.cancelState(state);
      return;
    }
    const runToken = ++state.runToken;
    try {
      const pinnedSourcePaths = [...this.options.getSettings().pinnedSessions].sort();
      const expandedSourcePaths = [...state.expandedSourcePaths].sort();
      // SessionCatalog.list() is canonical-path sorted.
      const allowedSourcePaths = this.catalog
        .sourcesForWorkspace(state.workspacePath)
        .map((source) => source.canonicalPath);
      const viewFingerprint = this.queryViewFingerprint(
        pinnedSourcePaths,
        expandedSourcePaths,
        allowedSourcePaths,
      );
      const queryPage = (pageOffset: number) =>
        this.index.query(
          state.workspacePath,
          state.query,
          pageOffset,
          state.pageSize,
          pinnedSourcePaths,
          expandedSourcePaths,
          allowedSourcePaths,
        );
      let effectiveDisposition = disposition;
      let effectiveOffset = offset;
      let response = await queryPage(effectiveOffset);
      if (!response.ok || response.type !== "query") return;
      // Offsets are stable only within one immutable index revision. If
      // progressive reconciliation changed ranking between pages, invalidate
      // the cursor and send a fresh first page instead of duplicates/omissions.
      if (
        effectiveDisposition === "append" &&
        state.pageRevision !== null &&
        (response.revision !== state.pageRevision || viewFingerprint !== state.pageViewFingerprint)
      ) {
        effectiveDisposition = "replace";
        effectiveOffset = 0;
        response = await queryPage(0);
      }
      if (
        !response.ok ||
        response.type !== "query" ||
        state.cancelled ||
        state.runToken !== runToken ||
        this.searches.get(state.searchId) !== state ||
        state.owner.isDestroyed()
      ) {
        return;
      }
      this.indexRevision = response.revision;
      this.workerCoverageByWorkspace.set(state.workspacePath, { ...response.coverage });
      let results = response.matches.map((match) =>
        this.resultForMatch(state, match, response.revision),
      );
      while (
        results.length > 0 &&
        Buffer.byteLength(JSON.stringify(results), "utf8") > SEARCH_BATCH_MAX_BYTES - 2048
      ) {
        results = results.slice(0, -1);
      }
      state.nextOffset = effectiveOffset + results.length;
      state.pageRevision = response.revision;
      state.pageViewFingerprint = viewFingerprint;
      const coverage = this.coverageForWorkspace(state.workspacePath);
      const done = this.reconcilePromise === null && state.nextOffset >= response.total;
      const batch: SessionSearchBatch = {
        rendererGeneration: state.rendererGeneration,
        clientQueryId: state.clientQueryId,
        searchId: state.searchId,
        sequence: state.sequence++,
        indexRevision: response.revision,
        disposition: effectiveDisposition,
        results,
        count: {
          value: response.total,
          exact: done && coverage.skippedSources === 0 && !response.truncated,
        },
        coverage,
        done,
      };
      this.sendBatch(state, batch);
    } catch (error) {
      if (state.cancelled || state.runToken !== runToken || state.owner.isDestroyed()) return;
      this.failure = error instanceof Error ? error.message : String(error);
      this.sendBatch(state, {
        rendererGeneration: state.rendererGeneration,
        clientQueryId: state.clientQueryId,
        searchId: state.searchId,
        sequence: state.sequence++,
        indexRevision: this.indexRevision,
        disposition,
        results: [],
        count: { value: 0, exact: false },
        coverage: this.coverageForWorkspace(state.workspacePath),
        done: true,
        error: this.failure,
      });
    }
  }

  /**
   * Renderer destruction can race the pre-send isDestroyed() check. Search
   * refreshes are deliberately fire-and-forget, so a closed IPC endpoint must
   * retire its capabilities instead of rejecting runPage() into the main
   * process as an unhandled promise.
   */
  private sendBatch(state: SearchState, batch: SessionSearchBatch): boolean {
    if (state.cancelled || state.owner.isDestroyed()) return false;
    try {
      state.owner.send("sessionSearch.batch", batch);
      return true;
    } catch {
      this.cancelState(state);
      return false;
    }
  }

  private resultForMatch(
    state: SearchState,
    match: SearchWorkerMatch,
    indexRevision: number,
  ): SessionSearchResult {
    const key = [
      match.sourcePath,
      match.entryOrdinal,
      match.entryId,
      match.contentPartKey,
      match.occurrence,
      match.contentDigest,
    ].join("\0");
    let targetId = state.targetIdsByKey.get(key);
    if (!targetId) {
      targetId = randomUUID() as SearchTargetId;
      state.targetIdsByKey.set(key, targetId);
    }
    const target: TargetRecord = {
      targetId,
      ownerId: state.owner.id,
      rendererGeneration: state.rendererGeneration,
      searchId: state.searchId,
      workspacePath: state.workspacePath,
      indexRevision,
      sourcePath: match.sourcePath,
      canonicalPath: match.sourcePath,
      sourceRevision: match.sourceRevision,
      headerSessionId: match.sessionId,
      entryOrdinal: match.entryOrdinal,
      byteStart: match.byteStart,
      byteEnd: match.byteEnd,
      entryId: match.entryId,
      contentPartKey: match.contentPartKey,
      occurrence: match.occurrence,
      digest: match.contentDigest,
      branchKind: match.latestPersistedPath ? "latest-persisted-path" : "other-saved-branch",
      sourceMatchRanges: match.sourceMatchRanges,
    };
    this.targets.delete(targetId);
    this.targets.set(targetId, target);
    this.trimTargets();
    return {
      targetId,
      sessionName: match.sessionName,
      ...(match.worktreeName ? { worktreeName: match.worktreeName } : {}),
      role: match.role,
      timestamp: match.timestamp,
      snippet: match.snippet,
      matchRanges: match.matchRanges,
      branchKind: target.branchKind ?? "latest-persisted-path",
      sourceRevision: match.sourceRevision,
      additionalMatches: match.additionalMatches,
      ...(match.closeMatchTerm ? { closeMatchTerm: match.closeMatchTerm } : {}),
    };
  }

  private currentStatus(workspacePath: string): SessionSearchIndexStatus {
    const coverage = this.coverageForWorkspace(workspacePath);
    if (this.failure) {
      return {
        state: "failed",
        indexRevision: this.indexRevision,
        coverage,
        message: this.failure,
      };
    }
    return {
      state: this.reconcilePromise ? "indexing" : this.initialized ? "ready" : "starting",
      indexRevision: this.indexRevision,
      coverage,
    };
  }

  private coverageForWorkspace(workspacePath: string) {
    const eligible = this.catalog
      .list()
      .filter(
        (source) =>
          source.workspacePath === workspacePath && source.health === "healthy" && !source.archived,
      );
    const catalogCoverage = this.catalog.coverage();
    const workerCoverage = this.workerCoverageByWorkspace.get(workspacePath);
    const fallbackIndexed = eligible.filter((source) =>
      this.reconciledPaths.has(source.canonicalPath),
    ).length;
    return {
      indexedSources: Math.min(
        eligible.length,
        Math.max(0, workerCoverage?.indexedSources ?? fallbackIndexed),
      ),
      totalSources: eligible.length,
      skippedSources: catalogCoverage.skippedSources + (workerCoverage?.skippedSources ?? 0),
    };
  }

  private adoptWorkerStatus(response: SearchWorkerResponse): void {
    if (!response.ok || !("revision" in response)) return;
    this.indexRevision = response.revision;
  }

  private replaceReconciledPaths(sources: SearchWorkerSource[]): void {
    this.reconciledPaths.clear();
    for (const source of sources) this.reconciledPaths.add(source.canonicalPath);
  }

  private ownsSearch(
    state: SearchState | undefined,
    rendererId: number,
    rendererGeneration: number,
  ): state is SearchState {
    return (
      !!state &&
      !state.cancelled &&
      state.owner.id === rendererId &&
      state.rendererGeneration === rendererGeneration
    );
  }

  private cancelState(state: SearchState): void {
    if (state.cancelled) return;
    state.cancelled = true;
    state.runToken += 1;
    state.contextRunToken += 1;
    this.searches.delete(state.searchId);
    for (const [targetId, target] of this.targets) {
      if (target.searchId === state.searchId) this.targets.delete(targetId);
    }
  }

  private attachRenderer(renderer: SearchRenderer): void {
    if (this.attachedRenderers.has(renderer.id)) return;
    this.attachedRenderers.add(renderer.id);
    renderer.once?.("destroyed", () => this.onRendererDestroyed(renderer.id));
  }

  private trimTargets(): void {
    while (this.targets.size > MAX_TARGETS) {
      const oldest = this.targets.keys().next().value;
      if (!oldest) break;
      this.targets.delete(oldest);
    }
  }

  private requireWorkspace(workspacePath: string): void {
    if (!this.workspaceRegistered(workspacePath)) {
      throw new Error("Workspace is not currently registered");
    }
  }

  private workspaceRegistered(workspacePath: string): boolean {
    return this.options.getSettings().workspaceOrder.includes(workspacePath);
  }
}
