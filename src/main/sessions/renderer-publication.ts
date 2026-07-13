import type { SessionId } from "@shared/ids.js";
import type {
  AuthorityAttachBaseline,
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

export type AuthorityBaselineProvider = () => Promise<AuthorityAttachBaseline>;

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
    if (panel.sync.state !== "following") return highest;
    return highest === undefined
      ? panel.sync.cursor.transportSequence
      : Math.max(highest, panel.sync.cursor.transportSequence);
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
    this.lastTransportSequence.clear();
    this.synchronizingPlanes.clear();
    // Owner replacement itself requires a new all-plane baseline.
    if (this.state === "following") this.state = "synchronizing";
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

  async attach(
    rendererGeneration: number,
    getBaseline: AuthorityBaselineProvider,
  ): Promise<AuthorityAttachResponse> {
    if (this.rendererGeneration === undefined || rendererGeneration > this.rendererGeneration) {
      this.rendererGeneration = rendererGeneration;
      this.nextPublicationSequence = 1;
    } else if (rendererGeneration < this.rendererGeneration) {
      throw new AuthorityAttachError("Stale renderer generation");
    }

    this.state = "attaching";
    this.buffer = [];
    this.overflowed = false;

    for (let attempt = 0; attempt < this.maxBaselineAttempts; attempt++) {
      // This is the main-owned publication high-water covered by the baseline
      // request. Publications routed while the child serializes its baseline
      // receive strictly greater numbers and form the replay tail. The child
      // cannot name this renderer-local sequence space.
      const highWatermark = this.nextPublicationSequence - 1;
      const sourceBaseline = await getBaseline();
      const baselineOwner = sourceBaseline.owner;
      if (!sameOwner(sourceBaseline.semantic.snapshot.owner, baselineOwner)) {
        throw new AuthorityAttachError("Authority baseline semantic owner mismatch");
      }

      // The baseline is serialized by the child after its earlier authority
      // work and names the main publication high-water it covers. Only the
      // strictly newer buffered tail may be replayed.
      const replay = this.buffer.filter(
        ({ publication }) => publication.publicationSequence > highWatermark,
      );
      const ownerChanged =
        this.expectedOwner !== undefined && !sameOwner(this.expectedOwner, baselineOwner);
      const foreignTail = replay.some(
        ({ publication }) => !sameOwner(baselineOwner, publication.owner),
      );

      if (
        this.overflowed ||
        ownerChanged ||
        foreignTail ||
        !this.contiguousFromBaseline(sourceBaseline, replay)
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
        ...structuredClone(sourceBaseline),
        sessionId: this.sessionId,
        rendererGeneration,
        publicationHighWatermark: highWatermark,
      };
      this.expectedOwner = structuredClone(baselineOwner);
      this.seedCursors(baseline);
      for (const entry of replay) {
        this.lastTransportSequence.set(entry.publication.plane, entry.transportSequence);
      }
      this.buffer = [];
      this.synchronizingPlanes.clear();
      this.state = "following";
      return { baseline, replay: replay.map(({ publication }) => publication) };
    }

    this.state = "synchronizing";
    throw new AuthorityAttachError("Authority publication attach overflow or continuity failure");
  }

  private seedCursors(baseline: AuthorityAttachBaseline): void {
    this.lastTransportSequence.clear();
    for (const plane of ["semantic", "transcript", "extensionUi", "panel"] as const) {
      const sequence = cursorSequence(baseline, plane);
      if (sequence !== undefined) this.lastTransportSequence.set(plane, sequence);
    }
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
