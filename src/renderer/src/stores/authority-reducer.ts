import type {
  AuthorityAttachResponse,
  AuthorityCursor,
  AuthorityFrame,
  AuthorityRecord,
  ExtensionUiPresentationBaseline,
  PanelPresentationBaseline,
  Plane,
  PlaneSync,
  RendererPublication,
  RuntimeIdentity,
  SemanticSnapshot,
  TranscriptPresentationBaseline,
} from "@shared/pi-protocol/runtime-state.js";

/**
 * Renderer-only projection of the authority-frame protocol. This deliberately
 * does not feed the legacy session projection: while migration is in shadow
 * mode, frame and legacy state can meet only at an attach baseline.
 */
export interface AuthorityPanelProjection {
  baseline: PanelPresentationBaseline;
  sync: PlaneSync;
  /** Bounded replay segment used only to seed a newly mounted terminal. */
  ansi: readonly string[];
  /** Latest accepted render operation; mounted terminals consume this incrementally. */
  output?:
    | {
        kind: "keyframe" | "delta" | "reset";
        sequence: number;
        renderRevision: number;
        ansi: string;
      }
    | undefined;
  inputEnabled: boolean;
}

export interface RendererAuthorityState {
  rendererGeneration?: number | undefined;
  owner?: RuntimeIdentity | undefined;
  /** Last global publication accepted for this renderer generation. */
  publicationSequence?: number | undefined;
  /** Shared source cursor for the whole panel plane, never per panel ID. */
  panelTransportSequence?: number | undefined;
  semantic: PlaneSync;
  transcript: PlaneSync;
  extensionUi: PlaneSync;
  panels: ReadonlyMap<string, AuthorityPanelProjection>;
  authoritativeSnapshot?: SemanticSnapshot | undefined;
  staleDiagnosticSnapshot?: SemanticSnapshot | undefined;
  /** The complete, atomic semantic commit most recently applied. */
  lastSemanticFrame?: AuthorityFrame | undefined;
  recentRecords: readonly AuthorityRecord[];
  transcriptBaseline?: TranscriptPresentationBaseline | undefined;
  extensionUiBaseline?: ExtensionUiPresentationBaseline | undefined;
}

const ATTACH_REQUIRED = "attach_required";

function synchronizing(lastCursor: AuthorityCursor | undefined, reason: string): PlaneSync {
  return lastCursor
    ? { state: "synchronizing", lastCursor, reason }
    : { state: "synchronizing", reason };
}

function unavailable(lastCursor: AuthorityCursor | undefined, reason: string): PlaneSync {
  return lastCursor
    ? { state: "unavailable", lastCursor, reason }
    : { state: "unavailable", reason };
}

function cursorOf(sync: PlaneSync): AuthorityCursor | undefined {
  return sync.state === "following" ? sync.cursor : sync.lastCursor;
}

function sameOwner(a: RuntimeIdentity | undefined, b: RuntimeIdentity): boolean {
  return !!a && a.hostInstanceId === b.hostInstanceId && a.sessionEpoch === b.sessionEpoch;
}

function isFollowingFor(
  sync: PlaneSync,
  owner: RuntimeIdentity,
): sync is Extract<PlaneSync, { state: "following" }> {
  return sync.state === "following" && sameOwner(sync.cursor, owner);
}

function panelInputEnabled(panel: PanelPresentationBaseline): boolean {
  return panel.sync.state === "following" && panel.keyframe.kind === "keyframe";
}

function allPanelsSynchronizing(
  state: RendererAuthorityState,
  reason: string,
): RendererAuthorityState {
  const panels = new Map<string, AuthorityPanelProjection>();
  for (const [key, panel] of state.panels) {
    const sync = synchronizing(cursorOf(panel.sync), reason);
    panels.set(key, { ...panel, sync, inputEnabled: false });
  }
  return { ...state, panels };
}

function allSynchronizing(state: RendererAuthorityState, reason: string): RendererAuthorityState {
  const panels = new Map<string, AuthorityPanelProjection>();
  for (const [key, panel] of state.panels) {
    const sync = synchronizing(cursorOf(panel.sync), reason);
    panels.set(key, { ...panel, sync, inputEnabled: false });
  }
  return {
    ...state,
    semantic: synchronizing(cursorOf(state.semantic), reason),
    transcript: synchronizing(cursorOf(state.transcript), reason),
    extensionUi: synchronizing(cursorOf(state.extensionUi), reason),
    panels,
    authoritativeSnapshot: undefined,
    staleDiagnosticSnapshot: state.authoritativeSnapshot ?? state.staleDiagnosticSnapshot,
  };
}

export function createRendererAuthorityState(): RendererAuthorityState {
  return {
    semantic: synchronizing(undefined, ATTACH_REQUIRED),
    transcript: synchronizing(undefined, ATTACH_REQUIRED),
    extensionUi: synchronizing(undefined, ATTACH_REQUIRED),
    panels: new Map(),
    recentRecords: [],
  };
}

/** Mark only the named presentation plane non-authoritative. */
export function synchronizeAuthorityPlane(
  state: RendererAuthorityState,
  plane: Plane,
  reason: string,
  panelKey?: string,
): RendererAuthorityState {
  if (plane === "semantic") {
    return {
      ...state,
      semantic: synchronizing(cursorOf(state.semantic), reason),
      authoritativeSnapshot: undefined,
      staleDiagnosticSnapshot: state.authoritativeSnapshot ?? state.staleDiagnosticSnapshot,
    };
  }
  if (plane === "transcript") {
    return { ...state, transcript: synchronizing(cursorOf(state.transcript), reason) };
  }
  if (plane === "extensionUi") {
    return { ...state, extensionUi: synchronizing(cursorOf(state.extensionUi), reason) };
  }
  if (!panelKey) return state;
  const panel = state.panels.get(panelKey);
  if (!panel) return state;
  const panels = new Map(state.panels);
  panels.set(panelKey, {
    ...panel,
    sync: synchronizing(cursorOf(panel.sync), reason),
    inputEnabled: false,
  });
  return { ...state, panels };
}

/** A failed attach is availability of the authority transport, not semantic idle. */
export function unavailableAuthority(
  state: RendererAuthorityState,
  reason: string,
): RendererAuthorityState {
  const panels = new Map<string, AuthorityPanelProjection>();
  for (const [key, panel] of state.panels) {
    panels.set(key, {
      ...panel,
      sync: unavailable(cursorOf(panel.sync), reason),
      inputEnabled: false,
    });
  }
  return {
    ...state,
    semantic: unavailable(cursorOf(state.semantic), reason),
    transcript: unavailable(cursorOf(state.transcript), reason),
    extensionUi: unavailable(cursorOf(state.extensionUi), reason),
    panels,
    authoritativeSnapshot: undefined,
    staleDiagnosticSnapshot: state.authoritativeSnapshot ?? state.staleDiagnosticSnapshot,
  };
}

function installBaseline(
  state: RendererAuthorityState,
  response: Extract<AuthorityAttachResponse, { status: "ready" }>,
): RendererAuthorityState {
  const { baseline } = response;
  if (
    state.rendererGeneration !== undefined &&
    (baseline.rendererGeneration < state.rendererGeneration ||
      (baseline.rendererGeneration === state.rendererGeneration &&
        (state.publicationSequence ?? -1) > baseline.publicationHighWatermark))
  ) {
    // A delayed attach response must never roll a newer projection backward.
    return state;
  }

  const panels = new Map<string, AuthorityPanelProjection>();
  for (const panel of baseline.panels) {
    panels.set(panel.panelKey, {
      baseline: panel,
      sync: panel.sync,
      ansi: panel.keyframe.kind === "keyframe" ? [panel.keyframe.ansi] : [],
      ...(panel.keyframe.kind === "keyframe" && cursorOf(panel.sync)
        ? {
            output: {
              kind: "keyframe" as const,
              sequence: cursorOf(panel.sync)!.transportSequence,
              renderRevision: panel.keyframe.renderRevision,
              ansi: panel.keyframe.ansi,
            },
          }
        : {}),
      inputEnabled: panelInputEnabled(panel),
    });
  }
  const semanticFollowing = baseline.semantic.sync.state === "following";
  return {
    rendererGeneration: baseline.rendererGeneration,
    owner: baseline.owner,
    publicationSequence: baseline.publicationHighWatermark,
    panelTransportSequence: baseline.panels.reduce<number | undefined>((highest, panel) => {
      const sequence = cursorOf(panel.sync)?.transportSequence;
      if (sequence === undefined) return highest;
      return highest === undefined ? sequence : Math.max(highest, sequence);
    }, undefined),
    semantic: baseline.semantic.sync,
    transcript: baseline.transcript.sync,
    extensionUi: baseline.extensionUi.sync,
    panels,
    authoritativeSnapshot: semanticFollowing ? baseline.semantic.snapshot : undefined,
    staleDiagnosticSnapshot: semanticFollowing ? undefined : baseline.semantic.snapshot,
    lastSemanticFrame: undefined,
    recentRecords: [],
    transcriptBaseline: baseline.transcript,
    extensionUiBaseline: baseline.extensionUi,
  };
}

/**
 * Install an attach baseline and atomically replay its contiguous buffered
 * tail. A malformed/reordered tail fences all planes; no baseline is silently
 * called current merely because it contained a complete snapshot.
 */
export function reduceAuthorityAttach(
  state: RendererAuthorityState,
  response: Extract<AuthorityAttachResponse, { status: "ready" }>,
): RendererAuthorityState {
  let next = installBaseline(state, response);
  if (next === state) return state;
  let expected = response.baseline.publicationHighWatermark + 1;
  for (const publication of response.replay) {
    if (
      publication.sessionId !== response.baseline.sessionId ||
      publication.rendererGeneration !== response.baseline.rendererGeneration ||
      publication.publicationSequence !== expected
    ) {
      return allSynchronizing(next, "attach_replay_gap");
    }
    next = reduceAuthorityPublication(next, publication);
    expected += 1;
  }
  return next;
}

function publicationCursor(publication: RendererPublication): AuthorityCursor | undefined {
  if (publication.plane === "semantic") {
    const frame = publication.payload;
    return {
      ...frame.owner,
      transportSequence: frame.transportSequence,
      snapshotSequence: frame.terminalSnapshot.snapshotSequence,
    };
  }
  return publication.payload.cursor;
}

function reduceSemantic(
  state: RendererAuthorityState,
  publication: Extract<RendererPublication, { plane: "semantic" }>,
): RendererAuthorityState {
  const frame = publication.payload;
  const priorCursor = cursorOf(state.semantic);
  const nextCursor: AuthorityCursor = {
    ...frame.owner,
    transportSequence: frame.transportSequence,
    snapshotSequence: frame.terminalSnapshot.snapshotSequence,
  };
  if (!isFollowingFor(state.semantic, frame.owner)) {
    // A later complete frame is useful diagnostic evidence, but cannot repair
    // a missing boundary or make records authoritative by itself.
    return {
      ...state,
      staleDiagnosticSnapshot: frame.terminalSnapshot,
      semantic: synchronizing(priorCursor, "semantic_baseline_required"),
    };
  }
  const previous = state.semantic.cursor;
  if (
    frame.transportSequence <= previous.transportSequence ||
    frame.terminalSnapshot.snapshotSequence <= previous.snapshotSequence
  ) {
    return state;
  }
  if (frame.transportSequence !== previous.transportSequence + 1) {
    return {
      ...state,
      semantic: synchronizing(previous, "semantic_transport_gap"),
      authoritativeSnapshot: undefined,
      staleDiagnosticSnapshot: state.authoritativeSnapshot ?? frame.terminalSnapshot,
    };
  }
  // One return value is the atomic frame reduction: records and terminal
  // snapshot are installed together, never through component callbacks.
  return {
    ...state,
    semantic: { state: "following", cursor: nextCursor },
    authoritativeSnapshot: frame.terminalSnapshot,
    staleDiagnosticSnapshot: undefined,
    lastSemanticFrame: frame,
    recentRecords: frame.records,
  };
}

function reduceTranscript(
  state: RendererAuthorityState,
  publication: Extract<RendererPublication, { plane: "transcript" }>,
): RendererAuthorityState {
  if (!isFollowingFor(state.transcript, publication.owner)) return state;
  const cursor = publication.payload.cursor;
  if (cursor.transportSequence <= state.transcript.cursor.transportSequence) return state;
  if (cursor.transportSequence !== state.transcript.cursor.transportSequence + 1) {
    return {
      ...state,
      transcript: synchronizing(state.transcript.cursor, "transcript_transport_gap"),
    };
  }
  if (publication.payload.kind === "reset_required") {
    return {
      ...state,
      transcript: synchronizing(state.transcript.cursor, publication.payload.reason),
    };
  }
  const baseline = state.transcriptBaseline
    ? {
        ...state.transcriptBaseline,
        sync: { state: "following" as const, cursor },
        liveTailCursor: publication.payload.liveTailCursor,
      }
    : undefined;
  return { ...state, transcript: { state: "following", cursor }, transcriptBaseline: baseline };
}

function reduceExtensionUi(
  state: RendererAuthorityState,
  publication: Extract<RendererPublication, { plane: "extensionUi" }>,
): RendererAuthorityState {
  if (!isFollowingFor(state.extensionUi, publication.owner)) return state;
  const cursor = publication.payload.cursor;
  if (cursor.transportSequence <= state.extensionUi.cursor.transportSequence) return state;
  if (cursor.transportSequence !== state.extensionUi.cursor.transportSequence + 1) {
    return {
      ...state,
      extensionUi: synchronizing(state.extensionUi.cursor, "extension_ui_transport_gap"),
    };
  }
  if (publication.payload.kind === "baseline_required") {
    return {
      ...state,
      extensionUi: synchronizing(state.extensionUi.cursor, publication.payload.reason),
    };
  }
  const baseline = state.extensionUiBaseline
    ? (() => {
        const request = publication.payload.request;
        const next = {
          ...state.extensionUiBaseline,
          sync: { state: "following" as const, cursor },
          notifications: [...state.extensionUiBaseline.notifications],
          statuses: { ...state.extensionUiBaseline.statuses },
          widgets: Object.fromEntries(
            Object.entries(state.extensionUiBaseline.widgets).map(([key, lines]) => [
              key,
              [...lines],
            ]),
          ),
          dialogs: [...state.extensionUiBaseline.dialogs],
        };
        if (request.method === "notify") {
          next.notifications.push({
            id: request.id,
            message: request.message,
            ...(request.notifyType ? { type: request.notifyType } : {}),
          });
        } else if (request.method === "setStatus") {
          if (request.statusText === undefined) delete next.statuses[request.statusKey];
          else next.statuses[request.statusKey] = request.statusText;
        } else if (request.method === "setWidget") {
          if (request.widgetLines === undefined) delete next.widgets[request.widgetKey];
          else next.widgets[request.widgetKey] = [...request.widgetLines];
        } else if (["select", "confirm", "input", "editor"].includes(request.method)) {
          next.dialogs.push({
            request,
            rendererGeneration: state.rendererGeneration ?? 0,
            inputPending: true,
            acknowledged: false,
          });
        } else if (request.method === "providerAuth") {
          const dialog = {
            request,
            rendererGeneration: state.rendererGeneration ?? 0,
            inputPending: true,
            acknowledged: false,
          };
          const index = next.dialogs.findIndex((candidate) => candidate.request.id === request.id);
          if (index < 0) next.dialogs.push(dialog);
          else next.dialogs[index] = dialog;
        }
        return next;
      })()
    : undefined;
  return { ...state, extensionUi: { state: "following", cursor }, extensionUiBaseline: baseline };
}

const AUTHORITY_PANEL_BUFFER_MAX_CHARS = 512 * 1024;

function appendAuthorityPanelAnsi(
  buffer: readonly string[],
  data: string,
  unified: boolean,
): readonly string[] {
  const hardClearAt = unified ? data.lastIndexOf("\x1b[2J") : -1;
  const next = hardClearAt >= 0 ? [data.slice(hardClearAt)] : [...buffer, data];
  let total = next.reduce((sum, chunk) => sum + chunk.length, 0);
  while (next.length > 1 && total > AUTHORITY_PANEL_BUFFER_MAX_CHARS) {
    total -= next.shift()?.length ?? 0;
  }
  const onlyChunk = next[0];
  if (next.length === 1 && onlyChunk && total > AUTHORITY_PANEL_BUFFER_MAX_CHARS) {
    next[0] = onlyChunk.slice(-AUTHORITY_PANEL_BUFFER_MAX_CHARS);
  }
  return next;
}

function reducePanel(
  state: RendererAuthorityState,
  publication: Extract<RendererPublication, { plane: "panel" }>,
): RendererAuthorityState {
  const payload = publication.payload;
  const key = payload.kind === "keyframe" ? payload.panel.panelKey : payload.panelKey;
  const existing = state.panels.get(key);
  if (payload.kind === "keyframe") {
    if (!sameOwner(payload.panel.owner, publication.owner) || !existing) return state;
    const cursor = payload.cursor;
    const panelCursor = cursorOf(payload.panel.sync);
    if (!panelCursor || panelCursor.transportSequence !== cursor.transportSequence) {
      return synchronizeAuthorityPlane(state, "panel", "panel_keyframe_gap", key);
    }
    const panels = new Map(state.panels);
    const sameRenderRevision =
      existing.baseline.keyframe.kind === "keyframe" &&
      payload.panel.keyframe.kind === "keyframe" &&
      existing.baseline.keyframe.renderRevision === payload.panel.keyframe.renderRevision;
    panels.set(key, {
      baseline: payload.panel,
      sync: payload.panel.sync,
      ansi: sameRenderRevision
        ? existing.ansi
        : payload.panel.keyframe.kind === "keyframe"
          ? [payload.panel.keyframe.ansi]
          : [],
      ...(payload.panel.keyframe.kind === "keyframe"
        ? {
            output: {
              kind: "keyframe" as const,
              sequence: cursor.transportSequence,
              renderRevision: payload.panel.keyframe.renderRevision,
              ansi: payload.panel.keyframe.ansi,
            },
          }
        : {}),
      inputEnabled: panelInputEnabled(payload.panel),
    });
    return { ...state, panels };
  }
  if (!existing && payload.kind === "reset" && payload.panelId !== undefined) {
    const baseline: PanelPresentationBaseline = {
      panelKey: key,
      panelId: payload.panelId,
      owner: publication.owner,
      sync: synchronizing(payload.cursor, "panel_reset"),
      overlay: payload.overlay === true,
      unified: payload.unified === true,
      mode: payload.mode ?? (payload.unified === true ? "content" : "viewport"),
      inputAcknowledgedThrough: 0,
      keyframe: { kind: "repaint_required", renderRevision: payload.renderRevision },
    };
    const panels = new Map(state.panels);
    panels.set(key, {
      baseline,
      sync: baseline.sync,
      ansi: [],
      output: {
        kind: "reset",
        sequence: payload.cursor.transportSequence,
        renderRevision: payload.renderRevision,
        ansi: "",
      },
      inputEnabled: false,
    });
    return { ...state, panels };
  }
  if (!existing || !sameOwner(existing.baseline.owner, publication.owner)) return state;
  const cursor = payload.cursor;
  const panels = new Map(state.panels);
  // ANSI bytes can only extend a current keyframe. Control records continue
  // advancing a fenced panel so a following keyframe has a contiguous cursor.
  if (payload.kind === "ansi_delta" && !isFollowingFor(existing.sync, publication.owner)) {
    if (existing.baseline.keyframe.kind !== "keyframe") {
      panels.set(key, { ...existing, sync: synchronizing(cursor, "panel_keyframe_required") });
      return { ...state, panels };
    }
    // A complete pending keyframe may receive later deltas while its repaint
    // acknowledgement is in flight. Render them in order but keep input fenced.
    panels.set(key, {
      ...existing,
      sync: synchronizing(
        cursor,
        existing.sync.state === "synchronizing" ? existing.sync.reason : "repaint_ack_pending",
      ),
      ansi: appendAuthorityPanelAnsi(existing.ansi, payload.data, existing.baseline.unified),
      output: {
        kind: "delta",
        sequence: cursor.transportSequence,
        renderRevision: payload.renderRevision,
        ansi: payload.data,
      },
      inputEnabled: false,
    });
    return { ...state, panels };
  }
  if (payload.kind === "close") {
    panels.delete(key);
  } else if (payload.kind === "reset" || payload.kind === "repaint_required") {
    const baseline = {
      ...existing.baseline,
      ...(payload.kind === "reset" && payload.panelId !== undefined
        ? { panelId: payload.panelId }
        : {}),
      ...(payload.kind === "reset" && payload.overlay !== undefined
        ? { overlay: payload.overlay }
        : {}),
      ...(payload.kind === "reset" && payload.unified !== undefined
        ? { unified: payload.unified }
        : {}),
      ...(payload.kind === "reset" && payload.mode !== undefined ? { mode: payload.mode } : {}),
      keyframe: { kind: "repaint_required" as const, renderRevision: payload.renderRevision },
    };
    panels.set(key, {
      ...existing,
      baseline,
      sync: synchronizing(cursor, payload.kind === "reset" ? "panel_reset" : payload.reason),
      ansi: [],
      output: {
        kind: "reset",
        sequence: cursor.transportSequence,
        renderRevision: payload.renderRevision,
        ansi: "",
      },
      inputEnabled: false,
    });
  } else if (payload.kind === "mode") {
    panels.set(key, {
      ...existing,
      baseline: { ...existing.baseline, mode: payload.mode },
      sync:
        existing.sync.state === "following"
          ? { state: "following", cursor }
          : synchronizing(cursor, existing.sync.reason),
    });
  } else {
    panels.set(key, {
      ...existing,
      sync: { state: "following", cursor },
      ansi: appendAuthorityPanelAnsi(existing.ansi, payload.data, existing.baseline.unified),
      output: {
        kind: "delta",
        sequence: cursor.transportSequence,
        renderRevision: payload.renderRevision,
        ansi: payload.data,
      },
    });
  }
  return { ...state, panels };
}

/** Reduce one sequenced publication. Older/reordered messages are no-ops. */
export function reduceAuthorityPublication(
  state: RendererAuthorityState,
  publication: RendererPublication,
): RendererAuthorityState {
  if (
    state.rendererGeneration === undefined ||
    publication.rendererGeneration !== state.rendererGeneration
  ) {
    return state;
  }
  if (publication.publicationSequence <= (state.publicationSequence ?? 0)) return state;
  if (publication.publicationSequence !== (state.publicationSequence ?? 0) + 1) {
    // publicationSequence is a single main-process sequence, so a gap does
    // not identify the source plane that was lost. Fence every projection
    // until a serialized baseline re-establishes their independent cursors.
    const fenced = allSynchronizing(state, "publication_gap");
    return { ...fenced, publicationSequence: publication.publicationSequence };
  }
  if (!sameOwner(state.owner, publication.owner)) {
    // Replacement is baseline-only. In particular, a delayed predecessor must
    // be a true no-op rather than fencing or otherwise changing its successor.
    return state;
  }

  const cursor = publicationCursor(publication);
  if (cursor && !sameOwner(cursor, publication.owner)) return state;
  let next: RendererAuthorityState;
  switch (publication.plane) {
    case "semantic":
      next = reduceSemantic(state, publication);
      break;
    case "transcript":
      next = reduceTranscript(state, publication);
      break;
    case "extensionUi":
      next = reduceExtensionUi(state, publication);
      break;
    case "panel": {
      if (!cursor) return state;
      const prior = state.panelTransportSequence;
      if (prior !== undefined && cursor.transportSequence <= prior) {
        return { ...state, publicationSequence: publication.publicationSequence };
      }
      if (prior !== undefined && cursor.transportSequence !== prior + 1) {
        const fenced = allPanelsSynchronizing(state, "panel_transport_gap");
        return {
          ...fenced,
          panelTransportSequence: cursor.transportSequence,
          publicationSequence: publication.publicationSequence,
        };
      }
      next = reducePanel(
        { ...state, panelTransportSequence: cursor.transportSequence },
        publication,
      );
      break;
    }
  }
  return { ...next, publicationSequence: publication.publicationSequence };
}
