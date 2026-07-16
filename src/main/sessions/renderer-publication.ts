import type { SessionId } from "@shared/ids.js";
import type {
  AuthorityAttachBaseline,
  AuthorityAttachBaselineResponse,
  AuthorityAttachResponse,
  AuthorityFrame,
  ExtensionUiPublicationPayload,
  PanelPublicationPayload,
  Plane,
  RendererPublication,
  RuntimeIdentity,
  TranscriptPublicationPayload,
} from "@shared/pi-protocol/runtime-state.js";

/** A child publication before main assigns its renderer generation and sequence. */
export type AuthorityPublication =
  | { plane: "semantic"; owner: RuntimeIdentity; payload: AuthorityFrame }
  | { plane: "transcript"; owner: RuntimeIdentity; payload: TranscriptPublicationPayload }
  | { plane: "extensionUi"; owner: RuntimeIdentity; payload: ExtensionUiPublicationPayload }
  | { plane: "panel"; owner: RuntimeIdentity; payload: PanelPublicationPayload };

export type AuthorityBaselineProvider = () => Promise<AuthorityAttachBaselineResponse>;

export class AuthorityAttachError extends Error {}

interface BufferedPublication {
  publication: RendererPublication;
  transportSequence: number;
}

interface RouterOptions {
  maxBufferedPublications?: number;
  maxBaselineAttempts?: number;
}

const sameOwner = (left: RuntimeIdentity | undefined, right: RuntimeIdentity): boolean =>
  left?.hostInstanceId === right.hostInstanceId && left?.sessionEpoch === right.sessionEpoch;

function transportSequence(publication: AuthorityPublication): number {
  return publication.plane === "semantic"
    ? publication.payload.transportSequence
    : publication.payload.cursor.transportSequence;
}

function cursorSequence(baseline: AuthorityAttachBaseline, plane: Plane): number | undefined {
  if (plane === "semantic") {
    return baseline.semantic.sync.state === "following"
      ? baseline.semantic.sync.cursor.transportSequence
      : undefined;
  }
  if (plane === "transcript") {
    return baseline.transcript.sync.state === "following"
      ? baseline.transcript.sync.cursor.transportSequence
      : undefined;
  }
  if (plane === "extensionUi") {
    return baseline.extensionUi.sync.state === "following"
      ? baseline.extensionUi.sync.cursor.transportSequence
      : undefined;
  }
  // Panel publications are independently keyed, but their stream shares the
  // panel plane transport cursor. A baseline with several panels therefore
  // starts at the greatest known panel cursor.
  return baseline.panels.reduce<number | undefined>((highest, panel) => {
    const cursor = panel.sync.state === "following" ? panel.sync.cursor : panel.sync.lastCursor;
    if (!cursor) return highest;
    return highest === undefined
      ? cursor.transportSequence
      : Math.max(highest, cursor.transportSequence);
  }, undefined);
}

/**
 * Main-process routing for one session's child publications.
 *
 * It deliberately does not reduce semantic frames: the semantic payload is
 * carried unchanged from child to renderer. Its only jobs are owner fencing,
 * renderer-generation sequencing, and baseline/replay buffering.
 */
export class RendererPublicationRouter {
  private readonly maxBufferedPublications: number;
  private readonly maxBaselineAttempts: number;
  private expectedOwner: RuntimeIdentity | undefined;
  private expectedOwnerRevision = 0;
  private attachRevision = 0;
  private inFlightAttach:
    | {
        rendererGeneration: number;
        ownerRevision: number;
        promise: Promise<AuthorityAttachResponse>;
      }
    | undefined;
  private rendererGeneration: number | undefined;
  private nextPublicationSequence = 1;
  private state: "detached" | "attaching" | "following" | "synchronizing" = "detached";
  /** A discontinuity fences its named plane only; semantic traffic must not
   * make a repainting panel (or vice versa) look current. */
  private readonly synchronizingPlanes = new Set<Plane>();
  private buffer: BufferedPublication[] = [];
  private overflowed = false;
  private readonly lastTransportSequence = new Map<Plane, number>();

  constructor(
    private readonly sessionId: SessionId,
    private readonly emit: (publication: RendererPublication) => void,
    options: RouterOptions = {},
  ) {
    this.maxBufferedPublications = options.maxBufferedPublications ?? 256;
    this.maxBaselineAttempts = options.maxBaselineAttempts ?? 3;
  }

  /** Fence predecessor traffic immediately when the registry installs a new owner. */
  setExpectedOwner(owner: RuntimeIdentity): void {
    if (sameOwner(this.expectedOwner, owner)) return;
    this.expectedOwner = structuredClone(owner);
    this.expectedOwnerRevision++;
    this.lastTransportSequence.clear();
    this.synchronizingPlanes.clear();
    // An already-running attach observes the owner revision after its await,
    // discards the mixed tail, and requests a fresh successor baseline. A new
    // caller will not coalesce with that predecessor-owner request.
    if (this.state === "attaching") {
      this.buffer = [];
      this.overflowed = false;
    } else if (this.state === "following") {
      this.state = "synchronizing";
    }
  }

  get synchronizing(): boolean {
    return this.state === "synchronizing" || this.synchronizingPlanes.size > 0;
  }

  route(publication: AuthorityPublication): boolean {
    if (!sameOwner(this.expectedOwner, publication.owner)) return false;
    if (this.rendererGeneration === undefined || this.state === "detached") return false;

    const sourceSequence = transportSequence(publication);
    if (!Number.isSafeInteger(sourceSequence) || sourceSequence <= 0) return false;
    const previous = this.lastTransportSequence.get(publication.plane);
    if (this.state === "following" && previous !== undefined) {
      if (sourceSequence <= previous) return false;
      if (sourceSequence !== previous + 1) {
        // Preserve the opaque frame so the renderer can name the discontinuity
        // at its cursor, but never let the router call the plane following.
        this.synchronizingPlanes.add(publication.plane);
        const routed: RendererPublication = {
          sessionId: this.sessionId,
          rendererGeneration: this.rendererGeneration,
          publicationSequence: this.nextPublicationSequence++,
          ...structuredClone(publication),
        } as RendererPublication;
        this.emit(routed);
        return true;
      }
    }

    const routed: RendererPublication = {
      sessionId: this.sessionId,
      rendererGeneration: this.rendererGeneration,
      publicationSequence: this.nextPublicationSequence++,
      ...structuredClone(publication),
    } as RendererPublication;

    if (this.state === "attaching") {
      this.buffer.push({ publication: routed, transportSequence: sourceSequence });
      if (this.buffer.length > this.maxBufferedPublications) {
        this.buffer = [];
        this.overflowed = true;
      }
      return true;
    }
    if (this.state !== "following") return false;
    // Keep routing unrelated following planes. A fenced plane's newer records
    // are harmless diagnostics in the renderer and cannot repair its gap.
    if (this.synchronizingPlanes.has(publication.plane)) {
      this.emit(routed);
      return true;
    }
    this.lastTransportSequence.set(publication.plane, sourceSequence);
    this.emit(routed);
    return true;
  }

  attach(
    rendererGeneration: number,
    getBaseline: AuthorityBaselineProvider,
  ): Promise<AuthorityAttachResponse> {
    if (this.rendererGeneration !== undefined && rendererGeneration < this.rendererGeneration) {
      return Promise.reject(new AuthorityAttachError("Stale renderer generation"));
    }
    const existing = this.inFlightAttach;
    if (
      existing?.rendererGeneration === rendererGeneration &&
      existing.ownerRevision === this.expectedOwnerRevision
    ) {
      return existing.promise;
    }

    const attachRevision = ++this.attachRevision;
    const ownerRevision = this.expectedOwnerRevision;
    const promise = this.performAttach(
      rendererGeneration,
      getBaseline,
      attachRevision,
      ownerRevision,
    );
    const inFlight = { rendererGeneration, ownerRevision, promise };
    this.inFlightAttach = inFlight;
    void promise
      .finally(() => {
        if (this.inFlightAttach === inFlight) this.inFlightAttach = undefined;
      })
      .catch(() => {});
    return promise;
  }

  private async performAttach(
    rendererGeneration: number,
    getBaseline: AuthorityBaselineProvider,
    attachRevision: number,
    initialOwnerRevision: number,
  ): Promise<AuthorityAttachResponse> {
    let ownerRevision = initialOwnerRevision;
    // A higher renderer generation supersedes the request, not the same-owner
    // transcript traffic that arrived while it was pending. Preserve that raw
    // bounded tail and reassign its renderer generation/sequence only after the
    // successor baseline classifies it.
    const inheritAttachingTail = this.state === "attaching";
    const inheritedBuffer = inheritAttachingTail ? this.buffer : [];
    const inheritedOverflow = inheritAttachingTail && this.overflowed;
    if (this.rendererGeneration === undefined || rendererGeneration > this.rendererGeneration) {
      this.rendererGeneration = rendererGeneration;
      this.nextPublicationSequence = 1;
    } else if (rendererGeneration < this.rendererGeneration) {
      throw new AuthorityAttachError("Stale renderer generation");
    }

    this.state = "attaching";
    this.buffer = inheritedBuffer;
    this.overflowed = inheritedOverflow;

    try {
      for (let attempt = 0; attempt < this.maxBaselineAttempts; attempt++) {
        // This is the main-owned publication high-water covered by the baseline
        // request. Publications routed while the child serializes its baseline
        // receive strictly greater numbers and form the replay tail. The child
        // cannot name this renderer-local sequence space.
        const highWatermark = this.nextPublicationSequence - 1;
        const source = await getBaseline();
        if (attachRevision !== this.attachRevision) {
          return { status: "unavailable", reason: "attach_superseded" };
        }
        if (ownerRevision !== this.expectedOwnerRevision) {
          ownerRevision = this.expectedOwnerRevision;
          this.buffer = [];
          this.overflowed = false;
          this.lastTransportSequence.clear();
          this.synchronizingPlanes.clear();
          continue;
        }
        if (source.status !== "ready") {
          // Do not leave the router buffering forever when the child deliberately
          // reports a normal lifecycle race.
          this.detach();
          return source;
        }
        const sourceBaseline = source.baseline;
        const baselineOwner = sourceBaseline.owner;
        if (!sameOwner(sourceBaseline.semantic.snapshot.owner, baselineOwner)) {
          throw new AuthorityAttachError("Authority baseline semantic owner mismatch");
        }

        // A child serializes its baseline after some authority work which may
        // have raced with this request. Therefore the request-time renderer
        // high-water alone cannot decide the replay tail: discard the covered
        // prefix for each source plane as named by the returned cursors.
        const classified = this.classifyBufferedTail(sourceBaseline);
        let installBaseline = sourceBaseline;
        let covered = classified.covered;
        let replay = classified.replay;

        // The transcript baseline carries cursors and streaming metadata, not
        // completed messages. A transcript delta received while attaching must
        // therefore be replayed even when the child baseline cursor already
        // covers it. Rewind only that plane to the predecessor cursor and keep
        // all buffered transcript records in their original cross-plane order.
        const firstCoveredTranscript = covered.find(
          ({ publication }) => publication.plane === "transcript",
        );
        if (firstCoveredTranscript) {
          const predecessorSequence = firstCoveredTranscript.transportSequence - 1;
          if (predecessorSequence <= 0 || sourceBaseline.transcript.sync.state !== "following") {
            this.buffer = [];
            this.overflowed = false;
            continue;
          }
          const replaySet = new Set(replay);
          replay = this.buffer.filter(
            (entry) => entry.publication.plane === "transcript" || replaySet.has(entry),
          );
          covered = covered.filter(({ publication }) => publication.plane !== "transcript");
          const { currentStreamingMessage: _coveredStreamingMessage, ...transcriptBaseline } =
            sourceBaseline.transcript;
          installBaseline = {
            ...sourceBaseline,
            transcript: {
              ...transcriptBaseline,
              sync: {
                state: "following",
                cursor: {
                  ...sourceBaseline.transcript.sync.cursor,
                  transportSequence: predecessorSequence,
                },
              },
              liveTailCursor: String(predecessorSequence),
            },
          };
        }

        // Buffered items have already consumed renderer sequence numbers. Make
        // every reconstructable covered item part of the baseline's renderer
        // history, then put the surviving cross-plane tail immediately after
        // that high-water. This avoids holes when covered prefixes interleave.
        const baselineHighWatermark = highWatermark + covered.length;
        const ownerChanged =
          this.expectedOwner !== undefined && !sameOwner(this.expectedOwner, baselineOwner);
        const foreignTail = replay.some(
          ({ publication }) => !sameOwner(baselineOwner, publication.owner),
        );

        if (
          this.overflowed ||
          ownerChanged ||
          foreignTail ||
          !this.contiguousFromBaseline(installBaseline, replay)
        ) {
          // A replacement, gap, or overflow cannot be repaired by retaining an
          // arbitrary tail. Discard it and ask the child for a new serialized
          // baseline. This is bounded so a flood cannot retain memory forever.
          this.expectedOwner = structuredClone(baselineOwner);
          this.buffer = [];
          this.overflowed = false;
          this.lastTransportSequence.clear();
          this.synchronizingPlanes.clear();
          continue;
        }

        const baseline: AuthorityAttachBaseline = {
          ...structuredClone(installBaseline),
          sessionId: this.sessionId,
          rendererGeneration,
          publicationHighWatermark: baselineHighWatermark,
        };
        this.expectedOwner = structuredClone(baselineOwner);
        this.seedCursors(baseline);
        for (const entry of replay) {
          this.lastTransportSequence.set(entry.publication.plane, entry.transportSequence);
        }
        this.buffer = [];
        this.synchronizingPlanes.clear();
        this.state = "following";
        this.nextPublicationSequence = baselineHighWatermark + replay.length + 1;
        return {
          status: "ready",
          baseline,
          replay: replay.map(({ publication }, index) => ({
            ...publication,
            rendererGeneration,
            publicationSequence: baselineHighWatermark + index + 1,
          })) as RendererPublication[],
        };
      }
    } catch (error) {
      if (attachRevision !== this.attachRevision) {
        return { status: "unavailable", reason: "attach_superseded" };
      }
      // Provider failures and malformed baselines must not strand the router
      // in attaching mode, where subsequent authority frames would be retained.
      this.detach();
      throw error;
    }

    if (attachRevision !== this.attachRevision) {
      return { status: "unavailable", reason: "attach_superseded" };
    }
    this.state = "synchronizing";
    throw new AuthorityAttachError("Authority publication attach overflow or continuity failure");
  }

  private detach(): void {
    this.buffer = [];
    this.overflowed = false;
    this.state = "detached";
  }

  private seedCursors(baseline: AuthorityAttachBaseline): void {
    this.lastTransportSequence.clear();
    for (const plane of ["semantic", "transcript", "extensionUi", "panel"] as const) {
      const sequence = cursorSequence(baseline, plane);
      if (sequence !== undefined) this.lastTransportSequence.set(plane, sequence);
    }
  }

  /**
   * The baseline can cover frames received after main started the request.
   * Source transport sequences are per plane, so only a leading run on each
   * plane may be absorbed. A later out-of-order item remains replay work and
   * is rejected by the continuity check rather than silently disappearing.
   */
  private classifyBufferedTail(baseline: AuthorityAttachBaseline): {
    covered: BufferedPublication[];
    replay: BufferedPublication[];
  } {
    const covered: BufferedPublication[] = [];
    const replay: BufferedPublication[] = [];
    const acceptingCoveredPrefix = new Map<Plane, boolean>();

    for (const entry of this.buffer) {
      const plane = entry.publication.plane;
      const cursor = cursorSequence(baseline, plane);
      const isCoveredPrefix =
        cursor !== undefined &&
        (acceptingCoveredPrefix.get(plane) ?? true) &&
        entry.transportSequence <= cursor;
      if (isCoveredPrefix) {
        covered.push(entry);
      } else {
        acceptingCoveredPrefix.set(plane, false);
        replay.push(entry);
      }
    }
    return { covered, replay };
  }

  private contiguousFromBaseline(
    baseline: AuthorityAttachBaseline,
    replay: BufferedPublication[],
  ): boolean {
    const cursors = new Map<Plane, number>();
    for (const plane of ["semantic", "transcript", "extensionUi", "panel"] as const) {
      const sequence = cursorSequence(baseline, plane);
      if (sequence !== undefined) cursors.set(plane, sequence);
    }
    for (const { publication, transportSequence: sequence } of replay) {
      const previous = cursors.get(publication.plane);
      if (previous !== undefined && sequence !== previous + 1) return false;
      cursors.set(publication.plane, sequence);
    }
    return true;
  }
}
