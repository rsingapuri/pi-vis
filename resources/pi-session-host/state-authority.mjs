import * as crypto from "node:crypto";

/**
 * Host-side authority for direct public AgentSession snapshots and GUI ingress.
 * It deliberately owns only host facts (admission, barriers, custody); Pi getter
 * values are copied verbatim and are never inferred from events.
 */
export function createStateAuthority({
  hostInstanceId,
  initialSession,
  sendControl = () => {},
  sendRecord = () => {},
  // New consumers can receive one indivisible semantic frame. The legacy
  // record/control pair remains the default wire behavior until its protocol
  // is migrated, so this authority can be introduced without splitting an
  // existing host epoch.
  sendFrame = null,
  // Presentation traffic is deliberately independent of semantic frames.
  // It is opaque to main and is the sole sequenced route for transcript/UI.
  sendPresentation = null,
  operationJournalCapacity = 128,
  recentOutcomeCapacity = 64,
  dispatchedIntentCapacity = 128,
  dispatchedIntentPayloadBytes = 8 * 1024 * 1024,
  getCatalog = () => ({}),
  getEditor = () => ({ revision: 0, text: "", attachments: [] }),
  acceptEditorSubmission = () => false,
  onSubmissionResult = () => {},
  onAdmissionStuck = () => {},
  admissionStuckMs = 60_000,
  runWithSurface = (_surface, operation) => operation(),
}) {
  let session = initialSession;
  let sessionEpoch = 0;
  let snapshotSequence = 0;
  // Semantic frames have their own contiguous source cursor. Host IPC carries
  // unrelated transcript/UI/panel traffic, so its global sequence cannot be
  // used as a semantic-plane cursor.
  let semanticTransportSequence = 0;
  const presentationTransportSequence = {
    transcript: 1,
    extensionUi: 1,
    panel: 1,
  };
  const transcriptPresentation = {
    persistedHistoryCursor: initialSession.sessionFile ?? null,
    liveTailCursor: null,
    overlapBoundary: initialSession.sessionFile ? `persisted:${initialSession.sessionFile}` : null,
    currentStreamingMessage: undefined,
  };
  let stopped = false;
  // `actualCompaction` is the compatibility projection of the observed
  // lifecycle below. It is deliberately not a guess that events are complete.
  let actualCompaction = false;
  let compaction = {
    phase: "inactive",
    operationId: null,
    origin: null,
    attempt: 0,
    anomaly: null,
  };
  // Pi 0.80.6 mutates its public isCompacting getter on opposite sides of
  // synchronous lifecycle callbacks: automatic start sets it just after
  // compaction_start, while every end clears it just after compaction_end.
  // Reconcile the direct getter in a microtask instead of treating those
  // callback-time values as missing-event anomalies.
  let compactionGetterReconcilePending = false;
  let compactionGetterReconcileToken = 0;
  let nextOperationSequence = 0;
  let operationJournalTruncated = false;
  const operationJournal = [];
  const recentIntentOutcomes = [];
  const intentLedger = new Map();
  // Target-protocol intents are independent from the compatibility submission
  // ledger above. Their key is explicitly owner-bound, so an old owner's
  // duplicate can never be admitted by a successor.
  const dispatchedIntents = new Map();
  let nextDispatchedIntentSequence = 0;
  let dispatchedIntentTruncated = false;
  // Every emitted observed operation that has not reached a terminal state.
  // This is deliberately distinct from SDK getter projections: an invocation
  // is not fabricated as an observed Pi lifecycle start.
  const activeObservedOperations = new Map();
  let navigationDepth = 0;
  let submitting = 0;
  let unresolvedAdmissions = 0;
  let ingressSequence = 0;
  let barrierSequence = 0;
  let promptFence = null;
  let transition = null;
  let mutationSequence = 0;
  let lastMutationFingerprint;
  let closePreparation = null;
  const custody = [];
  const activeIntents = new Map();
  const restorations = new Map();
  const attachmentLedger = new Map();
  // Original GUI payloads retained only while their public queue slot remains
  // attributable. Pi exposes transformed text but no stable queue-item IDs;
  // an exact, attachment-free plain-text payload is the only kind the host may
  // rebuild atomically for user-requested remove/edit/reorder operations.
  const queuedPayloads = new Map();
  let queueMutationActive = false;
  // Positional identities parallel Pi's public transformed-text queues. Text is
  // presentation only: GUI ownership survives extension rewrites by following
  // FIFO queue slots and decorating the corresponding delivery event.
  let queueIdentity = { steer: [], followUp: [] };
  let queueLengths = { steer: 0, followUp: 0 };
  let queueValues = { steer: [], followUp: [] };
  // Idle prompts bypass Pi's public queues, but their preflight callback still
  // gives us an exact child-owned delivery identity before message_start can
  // fire re-entrantly. Persist that one identity until the direct user echo or
  // prompt settlement so renderer remount/sleep cannot turn accepted text back
  // into an apparently unsent draft.
  let directDeliveryIntentId = null;
  // Pi may acknowledge preflight before its public queue getter exposes the
  // accepted slot. Retain only the exact one-slot baseline claim until a later
  // direct read can prove that append; ambiguity discards the claim.
  const pendingQueueClaims = new Map();

  // One scheduler owns BOTH ordinary GUI ingress and custody draining. Deferred
  // custody belongs to earlier GUI intent, so it drains FIFO before later normal
  // ingress and can never race another submission.
  const ingress = [];
  const custodyWork = [];
  let schedulerRunning = false;
  let schedulerQueued = false;

  function schedule(priority, operation) {
    return new Promise((resolve, reject) => {
      (priority === "ingress" ? ingress : custodyWork).push({ operation, resolve, reject });
      if (!schedulerQueued) {
        schedulerQueued = true;
        queueMicrotask(runScheduler);
      }
    });
  }

  async function runScheduler() {
    if (schedulerRunning) return;
    schedulerQueued = false;
    schedulerRunning = true;
    try {
      while (ingress.length > 0 || custodyWork.length > 0) {
        // Work deferred by a completed compaction/navigation barrier belongs
        // to an earlier GUI intent, so it drains before later normal ingress.
        const job = custodyWork.shift() ?? ingress.shift();
        try {
          job.resolve(await job.operation());
        } catch (err) {
          job.reject(err);
        }
      }
    } finally {
      schedulerRunning = false;
      if ((ingress.length > 0 || custodyWork.length > 0) && !schedulerQueued) {
        schedulerQueued = true;
        queueMicrotask(runScheduler);
      }
    }
  }

  function forgetQueuedPayloads(intentIds) {
    for (const intentId of intentIds) {
      if (typeof intentId === "string") queuedPayloads.delete(intentId);
    }
  }

  function ownsQueuedIntent(intentId) {
    return queueIdentity.steer.includes(intentId) || queueIdentity.followUp.includes(intentId);
  }

  function retainQueuedPayload(request) {
    if (typeof request?.intentId !== "string" || request.intentId.length === 0) return;
    queuedPayloads.set(request.intentId, {
      intentId: request.intentId,
      requestedMode: request.requestedMode === "steer" ? "steer" : "followUp",
      text: request.text,
      images: structuredClone(request.images ?? []),
      surface: request.surface ?? "composer",
      // Queued slash commands may be expanded or extension-dispatched by Pi.
      // Replaying one through the public SDK would not preserve its original
      // semantics, so only ordinary prompts are eligible for queue mutation.
      replayable: typeof request.text === "string" && !request.text.startsWith("/"),
    });
  }

  function setQueueProjection(steering, followUp, steeringIntentIds, followUpIntentIds) {
    queueIdentity = {
      steer: [...steeringIntentIds],
      followUp: [...followUpIntentIds],
    };
    queueLengths = { steer: steering.length, followUp: followUp.length };
    queueValues = { steer: [...steering], followUp: [...followUp] };
    pendingQueueClaims.clear();
  }

  function reconcileQueueIdentity(steering, followUp, deliveryExpected = false) {
    const deliveredQueueIntentIds = [];
    for (const [mode, queue] of [
      ["steer", steering],
      ["followUp", followUp],
    ]) {
      const priorLength = queueLengths[mode];
      const priorValues = queueValues[mode];
      const identities = queueIdentity[mode];
      if (queue.length < priorLength) {
        const removedCount = priorLength - queue.length;
        const retainedSuffixUnchanged = queue.every(
          (value, index) => value === priorValues[index + removedCount],
        );
        const removed = identities.splice(0, removedCount);
        // Only a shrink first observed while handling a delivered user event
        // is delivery evidence. Snapshot-observed removals are destructive or
        // ambiguous and their identities are retired, never held for a future
        // unrelated event.
        if (deliveryExpected && retainedSuffixUnchanged && removedCount === 1) {
          const intentId = removed[0];
          if (intentId) deliveredQueueIntentIds.push(intentId);
        }
        forgetQueuedPayloads(removed);
        if (!retainedSuffixUnchanged) {
          forgetQueuedPayloads(identities);
          identities.fill(null);
        }
      } else if (queue.length > priorLength) {
        const priorPrefixUnchanged = priorValues.every((value, index) => value === queue[index]);
        if (!priorPrefixUnchanged) {
          forgetQueuedPayloads(identities);
          identities.fill(null);
        }
        identities.push(...Array(queue.length - priorLength).fill(null));
      } else if (queue.some((value, index) => value !== priorValues[index])) {
        // Equal-length replacement has no public provenance. Invalidate all
        // mappings rather than letting a replacement inherit a GUI identity.
        forgetQueuedPayloads(identities);
        identities.fill(null);
      }
      queueLengths[mode] = queue.length;
      queueValues[mode] = [...queue];
    }
    return deliveredQueueIntentIds;
  }

  function resolvePendingQueueClaims(steering, followUp) {
    for (const [intentId, claim] of pendingQueueClaims) {
      const queue = claim.mode === "steer" ? steering : followUp;
      const identities = queueIdentity[claim.mode];
      const baselineUnchanged = claim.priorValues.every((value, index) => value === queue[index]);
      if (
        queue.length === claim.priorLength + 1 &&
        baselineUnchanged &&
        identities[claim.priorLength] === null
      ) {
        identities[claim.priorLength] = intentId;
        pendingQueueClaims.delete(intentId);
      } else if (queue.length !== claim.priorLength || !baselineUnchanged) {
        // More than one append, replacement, shrink, or prefix mutation has no
        // public provenance. Never guess which slot belongs to this GUI intent.
        pendingQueueClaims.delete(intentId);
      }
    }
  }

  function readQueues(deliveryExpected = false) {
    const steering = [...session.getSteeringMessages()];
    const followUp = [...session.getFollowUpMessages()];
    const deliveredQueueIntentIds = reconcileQueueIdentity(steering, followUp, deliveryExpected);
    resolvePendingQueueClaims(steering, followUp);
    return { steering, followUp, deliveredQueueIntentIds };
  }

  function registerQueuedIntent(request, priorLength, priorValues) {
    const { steering, followUp } = readQueues();
    const mode = request.requestedMode === "steer" ? "steer" : "followUp";
    const queue = mode === "steer" ? steering : followUp;
    const identities = queueIdentity[mode];
    // Slash input can be an extension command, skill, or template whose
    // asynchronous expansion/handling has no public queue provenance. It is
    // never replayable by the queue manager, so it must not retain a deferred
    // positional claim that could later steal a normal prompt's queue slot.
    // A resulting public slot remains intentionally unowned/uneditable.
    if (request.text.startsWith("/")) {
      pendingQueueClaims.delete(request.intentId);
      queuedPayloads.delete(request.intentId);
      return;
    }
    if (identities.includes(request.intentId)) {
      retainQueuedPayload(request);
      pendingQueueClaims.delete(request.intentId);
      return;
    }
    const baselineUnchanged = priorValues.every((value, index) => value === queue[index]);
    // Successful admission may claim only the single slot appended relative
    // to its pre-prompt baseline. Extra/replaced slots are extension-owned or
    // ambiguous and must never inherit this GUI intent.
    if (queue.length === priorLength + 1 && baselineUnchanged && identities[priorLength] === null) {
      identities[priorLength] = request.intentId;
      retainQueuedPayload(request);
      pendingQueueClaims.delete(request.intentId);
      return;
    }
    if (queue.length === priorLength && baselineUnchanged) {
      retainQueuedPayload(request);
      pendingQueueClaims.set(request.intentId, {
        mode,
        priorLength,
        priorValues: [...priorValues],
      });
      return;
    }
    pendingQueueClaims.delete(request.intentId);
  }

  function finalizeQueuedIntentClaim(request, priorLength, priorValues) {
    // Pi may expose the accepted queue slot only as prompt() settles. Take one
    // final direct getter sample, then retire an unresolved claim permanently:
    // extension commands can report successful preflight without queueing, and
    // must never steal a later ordinary prompt's slot.
    registerQueuedIntent(request, priorLength, priorValues);
    pendingQueueClaims.delete(request.intentId);
    if (!ownsQueuedIntent(request.intentId)) queuedPayloads.delete(request.intentId);
  }

  function resetQueueIdentity() {
    queueIdentity = { steer: [], followUp: [] };
    queueLengths = { steer: 0, followUp: 0 };
    queueValues = { steer: [], followUp: [] };
    pendingQueueClaims.clear();
    queuedPayloads.clear();
  }

  function reconcileAttachmentLedger(steering, followUp) {
    // Public Pi state exposes transformed queue text but no intent/image
    // correlation. Aggregate counts cannot identify which of two queued items
    // was consumed (the queue shifts from the front), so retain every possible
    // original while that mode remains non-empty. The review record labels
    // these as unpaired originals. An empty authoritative mode is the only
    // safe observation that all of its attachment custody can be retired.
    for (const [intentId, item] of attachmentLedger) {
      const queue = item.requestedMode === "steer" ? steering : followUp;
      if (queue.length === 0 && !activeIntents.has(intentId)) {
        attachmentLedger.delete(intentId);
      }
    }
  }

  function stableFingerprint(value) {
    if (value === null || typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(stableFingerprint).join(",")}]`;
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableFingerprint(value[key])}`)
      .join(",")}}`;
  }

  function isStrictObject(value, keys) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const actual = Object.keys(value);
    return actual.every((key) => keys.includes(key)) && keys.every((key) => key in value);
  }

  function isOptional(value, predicate) {
    return value === undefined || predicate(value);
  }

  // Keep this child boundary strict even when a caller bypasses the typed main
  // IPC contract. It intentionally mirrors SessionIntentSchema without loading
  // TypeScript/Zod into the SDK host process.
  function isValidSessionIntent(intent) {
    if (!intent || typeof intent !== "object" || Array.isArray(intent)) return false;
    const image = (value) =>
      isStrictObject(value, ["type", "data", "mimeType"]) &&
      value.type === "image" &&
      typeof value.data === "string" &&
      typeof value.mimeType === "string";
    const nonEmpty = (value) => typeof value === "string" && value.length > 0;
    const nonNegativeInteger = (value) => Number.isInteger(value) && value >= 0;
    switch (intent.kind) {
      case "interrupt":
      case "refreshModels":
        return isStrictObject(intent, ["kind"]);
      case "loginProvider":
        return (
          isStrictObject(intent, ["kind", "providerId", "authType"]) &&
          nonEmpty(intent.providerId) &&
          ["oauth", "api_key"].includes(intent.authType)
        );
      case "reload":
        return (
          Object.keys(intent).every((key) =>
            ["kind", "editorRevision", "editorText"].includes(key),
          ) &&
          ((intent.editorRevision === undefined && intent.editorText === undefined) ||
            (nonNegativeInteger(intent.editorRevision) && typeof intent.editorText === "string"))
        );
      case "submit":
        return (
          isStrictObject(intent, [
            "kind",
            "editorRevision",
            "text",
            "images",
            "requestedMode",
            "surface",
          ]) &&
          nonNegativeInteger(intent.editorRevision) &&
          typeof intent.text === "string" &&
          Array.isArray(intent.images) &&
          intent.images.every(image) &&
          ["steer", "followUp"].includes(intent.requestedMode) &&
          ["composer", "unified"].includes(intent.surface)
        );
      case "manageQueue": {
        const operation = intent.operation;
        const allowed = [
          "kind",
          "operation",
          "targetIntentId",
          "text",
          "direction",
          "expectedSteeringIntentIds",
          "expectedFollowUpIntentIds",
        ];
        if (
          !Object.keys(intent).every((key) => allowed.includes(key)) ||
          !["remove", "update", "move", "clear"].includes(operation)
        ) {
          return false;
        }
        const queueIds = (value) =>
          Array.isArray(value) &&
          value.every((item) => typeof item === "string" && item.length > 0);
        const hasTarget =
          typeof intent.targetIntentId === "string" && intent.targetIntentId.length > 0;
        const hasText = typeof intent.text === "string" && intent.text.length > 0;
        const hasDirection = ["earlier", "later"].includes(intent.direction);
        const hasExpectation =
          intent.expectedSteeringIntentIds !== undefined ||
          intent.expectedFollowUpIntentIds !== undefined;
        if (operation === "clear") {
          return (
            intent.targetIntentId === undefined &&
            intent.text === undefined &&
            intent.direction === undefined &&
            queueIds(intent.expectedSteeringIntentIds) &&
            queueIds(intent.expectedFollowUpIntentIds)
          );
        }
        if (!hasTarget || hasExpectation) return false;
        if (operation === "update") return hasText && intent.direction === undefined;
        if (operation === "move") return intent.text === undefined && hasDirection;
        return intent.text === undefined && intent.direction === undefined;
      }
      case "compact":
        return (
          Object.keys(intent).every((key) => ["kind", "instructions"].includes(key)) &&
          isOptional(intent.instructions, (value) => typeof value === "string")
        );
      case "invokeCommand":
        return (
          isStrictObject(intent, ["kind", "text", "editorRevision"]) &&
          typeof intent.text === "string" &&
          nonNegativeInteger(intent.editorRevision)
        );
      case "runBash":
        return (
          Object.keys(intent).every((key) =>
            ["kind", "command", "excludeFromContext"].includes(key),
          ) &&
          typeof intent.command === "string" &&
          isOptional(intent.excludeFromContext, (value) => typeof value === "boolean")
        );
      case "navigate":
        return (
          Object.keys(intent).every((key) => ["kind", "targetId", "summarize"].includes(key)) &&
          nonEmpty(intent.targetId) &&
          isOptional(intent.summarize, (value) => typeof value === "boolean")
        );
      case "setModel":
        return (
          isStrictObject(intent, ["kind", "provider", "modelId"]) &&
          typeof intent.provider === "string" &&
          nonEmpty(intent.modelId)
        );
      case "setThinking":
        return (
          isStrictObject(intent, ["kind", "level"]) &&
          ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(intent.level)
        );
      case "rename":
        return isStrictObject(intent, ["kind", "name"]) && typeof intent.name === "string";
      case "export":
        return (
          Object.keys(intent).every((key) => ["kind", "outputPath"].includes(key)) &&
          isOptional(intent.outputPath, (value) => typeof value === "string")
        );
      default:
        return false;
    }
  }

  function intentFingerprint(request) {
    // Intent IDs identify a semantic operation, not a renderer retry. Include
    // every admission-relevant field so reusing one for a different payload is
    // a deterministic rejection rather than a second possible prompt.
    return stableFingerprint({
      hostInstanceId: request.expectedHostId,
      sessionEpoch: request.expectedEpoch,
      editorRevision: request.editorRevision,
      text: request.text,
      images: request.images ?? [],
      requestedMode: request.requestedMode,
      surface: request.surface,
    });
  }

  function intentOwnerKey(owner, intentId) {
    return `${owner.hostInstanceId}:${owner.sessionEpoch}:${intentId}`;
  }

  function appendOperation(recordValue) {
    const entry = {
      operationSequence: ++nextOperationSequence,
      observedAt: Date.now(),
      ...recordValue,
    };
    operationJournal.push(entry);
    const capacity = Math.max(1, Number(operationJournalCapacity) || 1);
    if (operationJournal.length > capacity) {
      operationJournal.splice(0, operationJournal.length - capacity);
      operationJournalTruncated = true;
    }
    return entry;
  }

  function journalBounds() {
    return {
      low: operationJournal[0]?.operationSequence ?? nextOperationSequence,
      high: nextOperationSequence,
      truncated: operationJournalTruncated,
    };
  }

  function appendAnomaly(code, detail) {
    return appendOperation({
      journalType: "anomaly",
      owner: semanticOwner(),
      code,
      ...(detail ? { detail: String(detail) } : {}),
    });
  }

  function journalRecords(owner = semanticOwner()) {
    return operationJournal
      .filter(
        (entry) =>
          entry.owner?.hostInstanceId === owner.hostInstanceId &&
          entry.owner?.sessionEpoch === owner.sessionEpoch,
      )
      .flatMap((entry) => {
        if (entry.observed === true) {
          return [
            {
              type: "observed_operation",
              sequence: entry.operationSequence,
              record: operationProjection(entry),
            },
          ];
        }
        if (entry.journalType === "intent_outcome" && entry.outcome) {
          return [
            {
              type: "intent_outcome",
              sequence: entry.operationSequence,
              outcome: structuredClone(entry.outcome),
            },
          ];
        }
        if (entry.journalType === "anomaly") {
          return [
            {
              type: "anomaly",
              sequence: entry.operationSequence,
              owner: structuredClone(entry.owner),
              code: entry.code,
              observedAt: entry.observedAt,
              ...(entry.detail ? { detail: String(entry.detail) } : {}),
            },
          ];
        }
        return [];
      });
  }

  function dispatchedIntentBounds() {
    const retained = [...dispatchedIntents.values()]
      .filter((entry) => entry.outcome)
      .sort((a, b) => a.recordSequence - b.recordSequence);
    return {
      low: retained[0]?.recordSequence ?? nextDispatchedIntentSequence,
      high: nextDispatchedIntentSequence,
      truncated: dispatchedIntentTruncated,
    };
  }

  function pruneDispatchedIntents() {
    const capacity = Math.max(1, Number(dispatchedIntentCapacity) || 1);
    const terminal = [...dispatchedIntents.entries()]
      .filter(([, entry]) => entry.outcome)
      .sort(([, a], [, b]) => a.recordSequence - b.recordSequence);
    while (dispatchedIntents.size > capacity && terminal.length > 0) {
      const [key] = terminal.shift();
      dispatchedIntents.delete(key);
      dispatchedIntentTruncated = true;
    }
  }

  function intentPayloadBytes(intent) {
    try {
      return Buffer.byteLength(JSON.stringify(intent), "utf8");
    } catch {
      return Number.POSITIVE_INFINITY;
    }
  }

  function retainedDispatchedIntent(intent) {
    // The execution closure holds the full payload only until settlement. Do
    // not retain text or image bytes merely to service a duplicate receipt.
    switch (intent.kind) {
      case "invokeCommand":
        return {
          kind: intent.kind,
          commandType:
            typeof intent.text === "string"
              ? intent.text.replace(/^\//, "").trim().split(/\s+/, 1)[0]
              : undefined,
        };
      case "setModel":
        return { kind: intent.kind, provider: intent.provider, modelId: intent.modelId };
      case "setThinking":
        return { kind: intent.kind, level: intent.level };
      case "rename":
        return { kind: intent.kind, name: intent.name };
      case "navigate":
        return { kind: intent.kind, targetId: intent.targetId, summarize: intent.summarize };
      default:
        return { kind: intent.kind };
    }
  }

  function observedOperation(
    kind,
    state,
    { operationId = crypto.randomUUID(), intentId, detail, command, targetId } = {},
  ) {
    const record = {
      kind,
      phase: state,
      observed: true,
      operationId,
      owner: semanticOwner(),
      ...(intentId ? { intentId } : {}),
      ...(detail ? { detail: String(detail) } : {}),
      ...(command ? { command: String(command) } : {}),
      ...(targetId ? { targetId: String(targetId) } : {}),
    };
    appendOperation(record);
    const key = `${kind}:${operationId}`;
    if (["completed", "aborted", "failed", "unknown"].includes(state)) {
      activeObservedOperations.delete(key);
    } else {
      activeObservedOperations.set(key, record);
    }
    return operationId;
  }

  function operationProjection(entry, state = entry.phase) {
    return {
      operationId: String(entry.operationId ?? entry.operationSequence),
      owner: structuredClone(entry.owner ?? semanticOwner()),
      kind: entry.kind,
      state,
      observedAt: entry.observedAt,
      ...(entry.intentId ? { intentId: entry.intentId } : {}),
      ...(entry.detail || entry.anomaly ? { detail: String(entry.detail ?? entry.anomaly) } : {}),
    };
  }

  function observedJournal(owner = semanticOwner()) {
    return operationJournal
      .filter(
        (entry) =>
          entry.observed === true &&
          entry.owner?.hostInstanceId === owner.hostInstanceId &&
          entry.owner?.sessionEpoch === owner.sessionEpoch,
      )
      .map((entry) => operationProjection(entry));
  }

  function activeOperation(kind) {
    return [...activeObservedOperations.values()].find((entry) => entry.kind === kind);
  }

  function activeOperationId(kind) {
    return activeOperation(kind)?.operationId;
  }

  function reconcileObservedGetters() {
    if (session.isRetrying === true && !activeOperationId("retry")) {
      observedOperation("retry", "retry_wait", { detail: "getter_without_start" });
    }
    if (session.isBashRunning === true && !activeOperationId("bash")) {
      observedOperation("bash", "active", { detail: "getter_without_start" });
    }
  }

  // Pi's public isCompacting getter deliberately covers both context
  // compaction and branch summarization. runNavigation gives us the public,
  // operation-specific evidence needed to disambiguate that getter. Treating
  // it as compaction while navigationDepth > 0 creates a phantom compaction:
  // there can be no matching compaction_end, so its barrier and cancelling
  // state can never settle.
  function compactionGetterActive() {
    return session.isCompacting === true && navigationDepth === 0;
  }

  function compactionBarrierOpen() {
    return (
      compactionGetterActive() ||
      compactionGetterReconcilePending ||
      ["active", "active_unknown_origin", "cancelling", "retry_wait"].includes(compaction.phase) ||
      compaction.invocationPending === true
    );
  }

  function setCompactionAnomaly(reason) {
    if (compaction.anomaly === reason) return;
    compaction = { ...compaction, anomaly: reason };
    appendAnomaly(reason, reason);
    observedOperation("compaction", "unknown", {
      operationId: compaction.operationId,
      detail: reason,
    });
  }

  function reconcileCompactionGetter() {
    const getterActive = compactionGetterActive();
    if (
      getterActive &&
      !compactionGetterReconcilePending &&
      ["inactive", "terminal_success", "terminal_aborted", "terminal_failed"].includes(
        compaction.phase,
      )
    ) {
      compaction = {
        phase: "active_unknown_origin",
        operationId: crypto.randomUUID(),
        origin: "getter",
        attempt: Math.max(1, compaction.attempt + 1),
        anomaly: "missing_compaction_start",
      };
      appendAnomaly("missing_compaction_start", "missing_compaction_start");
      observedOperation("compaction", "active", {
        operationId: compaction.operationId,
        detail: compaction.anomaly,
      });
    } else if (
      !getterActive &&
      !compactionGetterReconcilePending &&
      ["active", "active_unknown_origin", "cancelling"].includes(compaction.phase)
    ) {
      // An end event is the only evidence that closes an observed span. Keep
      // custody fenced when getters and events disagree instead of inventing
      // an end from a transient getter read.
      setCompactionAnomaly("getter_event_disagreement");
    }
    actualCompaction = compactionBarrierOpen();
  }

  function compactionProjection() {
    return {
      phase: compaction.phase,
      operationId: compaction.operationId,
      origin: compaction.origin,
      attempt: compaction.attempt,
      ...(compaction.anomaly ? { anomaly: compaction.anomaly } : {}),
      barrierOpen: compactionBarrierOpen(),
    };
  }

  function snapshot() {
    reconcileObservedGetters();
    reconcileCompactionGetter();
    const s = session;
    const { steering, followUp } = readQueues();
    reconcileAttachmentLedger(steering, followUp);
    return {
      hostInstanceId,
      sessionEpoch,
      snapshotSequence: ++snapshotSequence,
      capturedAt: Date.now(),
      isStreaming: s.isStreaming,
      isIdle: s.isIdle,
      isCompacting: s.isCompacting,
      isRetrying: s.isRetrying,
      retryAttempt: s.retryAttempt,
      isBashRunning: s.isBashRunning,
      model: s.model ?? null,
      thinkingLevel: s.thinkingLevel,
      sessionId: s.sessionId,
      sessionFile: s.sessionFile,
      sessionName: s.sessionName,
      pendingMessageCount: s.pendingMessageCount,
      steering,
      followUp,
      steeringIntentIds: [...queueIdentity.steer],
      followUpIntentIds: [...queueIdentity.followUp],
      hostFacts: {
        submitting: submitting > 0 || unresolvedAdmissions > 0,
        actualCompaction,
        navigation: navigationDepth > 0,
        pendingDialogs: Number(getCatalog()?.pendingDialogs ?? 0),
        custodyCount: custody.length,
        ...(compaction.anomaly ? { compactionAnomaly: compaction.anomaly } : {}),
      },
      // Semantic consumers use these bounded retained projections rather than
      // reconstructing lifecycle from raw event history.
      compaction: compactionProjection(),
      activeIntents: [...activeIntents].map(([intentId, disposition]) => ({
        intentId,
        disposition,
        payloadFingerprint: intentLedger.get(intentId)?.fingerprint,
      })),
      recentIntentOutcomes: structuredClone(recentIntentOutcomes),
      recentObservedOperations: structuredClone(operationJournal),
      operationJournalLowWatermark: journalBounds().low,
      operationJournalHighWatermark: journalBounds().high,
      operationJournalTruncated: journalBounds().truncated,
      catalog: getCatalog(),
      editor: getEditor(),
    };
  }

  function mutationFingerprint(value) {
    const { snapshotSequence: _sequence, capturedAt: _capturedAt, ...facts } = value;
    return JSON.stringify(facts);
  }

  function observeSnapshotMutation(value) {
    const fingerprint = mutationFingerprint(value);
    if (lastMutationFingerprint !== undefined && lastMutationFingerprint !== fingerprint) {
      mutationSequence++;
    }
    lastMutationFingerprint = fingerprint;
  }

  function noteMutation() {
    mutationSequence++;
  }

  function publishSnapshot(full = false) {
    const value = snapshot();
    if (!transition && typeof sendFrame === "function") {
      // Semantic consumers receive the frame, while the direct snapshot keeps
      // main's independent control-channel availability lease alive. Dropping
      // this compatibility control publication makes an otherwise healthy
      // idle session flap unavailable on every lease interval.
      const frame = createSemanticFrame([], value);
      sendFrame(frame);
      sendControl({ type: "snapshot", snapshot: value, full });
      return value;
    }
    observeSnapshotMutation(value);
    if (transition) {
      transition.lastSnapshot = value;
      return value;
    }
    sendControl({ type: "snapshot", snapshot: value, full });
    return value;
  }

  function record(recordValue) {
    noteMutation();
    if (transition) transition.records.push(recordValue);
    else if (typeof sendFrame === "function") commitSemanticFrame([recordValue]);
    else sendRecord(recordValue);
  }

  function terminalDisposition(disposition) {
    return [
      "completed",
      "rejected",
      "extension_error",
      "outcome_unknown",
      "not_submitted",
    ].includes(disposition);
  }

  function retainIntentOutcome(result) {
    if (!terminalDisposition(result.disposition)) return;
    const ledger = intentLedger.get(result.intentId);
    if (ledger?.terminalFingerprint === stableFingerprint(result)) return;
    if (ledger) {
      ledger.settled = true;
      ledger.terminal = structuredClone(result);
      ledger.terminalFingerprint = stableFingerprint(result);
    }
    recentIntentOutcomes.push(structuredClone(result));
    const capacity = Math.max(1, Number(recentOutcomeCapacity) || 1);
    if (recentIntentOutcomes.length > capacity) {
      recentIntentOutcomes.splice(0, recentIntentOutcomes.length - capacity);
    }
  }

  function semanticOwner() {
    return { hostInstanceId, sessionEpoch };
  }

  // The legacy snapshot intentionally remains available to compatibility
  // consumers. Frames use this separate, schema-shaped projection so no
  // renderer has to merge old host facts with a new semantic commit.
  function semanticSnapshot(value = snapshot()) {
    const owner = semanticOwner();
    const observed = observedJournal();
    // Keep the child-normalized typed outcome intact. Dropping result/error
    // here made a terminal frame unusable for consumers that correctly wait
    // for settlement instead of treating a receipt as completion.
    const outcomes = [...dispatchedIntents.values()]
      .filter(
        (entry) =>
          entry.outcome &&
          entry.owner.hostInstanceId === owner.hostInstanceId &&
          entry.owner.sessionEpoch === owner.sessionEpoch,
      )
      .map((entry) => structuredClone(entry.outcome));
    const active = [...dispatchedIntents.values()]
      .filter(
        (entry) =>
          !entry.outcome &&
          entry.owner.hostInstanceId === owner.hostInstanceId &&
          entry.owner.sessionEpoch === owner.sessionEpoch,
      )
      .map((entry) => ({
        intentId: entry.intentId,
        owner,
        kind: entry.kind,
        state: "admitted",
        recordedAt: entry.recordedAt,
      }));
    const agent = activeOperation("agent");
    const retry = activeOperation("retry");
    const bash = activeOperation("bash");
    const navigation = activeOperation("navigation");
    const command = activeOperation("command");
    // An admitted compact invocation fences custody, but it is not evidence
    // that Pi began compacting. Only a public getter or start observation may
    // project compaction activity.
    const compactionActive = [
      "active",
      "active_unknown_origin",
      "cancelling",
      "retry_wait",
    ].includes(compaction.phase);
    const compactionActivity = compactionActive
      ? {
          kind: "compaction",
          state:
            compaction.phase === "retry_wait"
              ? "retry_wait"
              : compaction.phase === "cancelling"
                ? "cancelling"
                : compaction.phase === "active_unknown_origin"
                  ? "active_unknown_origin"
                  : "active",
          attempt: Math.max(0, compaction.attempt),
          ...(compaction.operationId ? { intentId: compaction.operationId } : {}),
          ...(compaction.anomaly ? { anomaly: compaction.anomaly } : {}),
        }
      : undefined;
    return {
      owner,
      snapshotSequence: value.snapshotSequence,
      capturedAt: value.capturedAt,
      sdk: {
        isStreaming: value.isStreaming,
        isIdle: value.isIdle,
        isCompacting: value.isCompacting,
        isRetrying: value.isRetrying,
        retryAttempt: value.retryAttempt,
        isBashRunning: value.isBashRunning,
      },
      activity: {
        ...(agent
          ? { agent: { kind: "agent", state: "active", startedAt: agent.observedAt } }
          : {}),
        ...(compactionActivity ? { compaction: compactionActivity } : {}),
        ...(retry
          ? {
              retry: {
                kind: "retry",
                state: retry.phase === "retry_wait" ? "waiting" : "active",
                attempt: Math.max(0, Number(value.retryAttempt) || 0),
                startedAt: retry.observedAt,
              },
            }
          : {}),
        ...(bash
          ? {
              bash: {
                kind: "bash",
                state: bash.phase === "cancelling" ? "cancelling" : "active",
                ...(bash.intentId ? { intentId: bash.intentId } : {}),
                ...(bash.command ? { command: bash.command } : {}),
                startedAt: bash.observedAt,
              },
            }
          : {}),
        ...(navigation
          ? {
              navigation: {
                kind: "navigation",
                state: navigation.phase === "cancelling" ? "cancelling" : "active",
                ...(navigation.intentId ? { intentId: navigation.intentId } : {}),
                ...(navigation.targetId ? { targetId: navigation.targetId } : {}),
                startedAt: navigation.observedAt,
              },
            }
          : {}),
        ...(command?.intentId
          ? {
              command: {
                kind: "command",
                state: command.phase === "cancelling" ? "cancelling" : "invoking",
                intentId: command.intentId,
                command: command.command ?? "command",
                startedAt: command.observedAt,
              },
            }
          : {}),
      },
      queues: {
        steering: value.steering,
        followUp: value.followUp,
        steeringIntentIds: value.steeringIntentIds ?? value.steering.map(() => null),
        followUpIntentIds: value.followUpIntentIds ?? value.followUp.map(() => null),
        management: queueManagementAvailability(value.steering, value.followUp),
      },
      custody: custody.map((item) => ({
        custodyId: item.custodyId,
        intentId: item.request.intentId,
        owner,
        queueMode: item.request.requestedMode === "steer" ? "steer" : "followUp",
        barrier:
          item.phase === "compaction"
            ? "compaction"
            : item.phase === "navigation"
              ? "navigation"
              : "admission_fence",
        enteredAt: item.ingressSequence,
        certainty: "not_processed",
      })),
      editor: value.editor,
      activeIntents: active,
      recentIntentOutcomes: outcomes,
      recentObservedOperations: observed,
      operationJournalLowWatermark: value.operationJournalLowWatermark,
      operationJournalHighWatermark: value.operationJournalHighWatermark,
      operationJournalTruncated: value.operationJournalTruncated,
      dispatchedIntentLowWatermark: dispatchedIntentBounds().low,
      dispatchedIntentHighWatermark: dispatchedIntentBounds().high,
      dispatchedIntentTruncated: dispatchedIntentBounds().truncated,
      model: value.model,
      thinkingLevel: value.thinkingLevel,
      sessionName: value.sessionName,
      catalog: value.catalog,
    };
  }

  function authorityRecords(records) {
    const owner = semanticOwner();
    return records.flatMap((recordValue) => {
      // Production Pi events use the independently sequenced transcript
      // plane. A frame-only embedder still receives the atomic compatibility
      // record rather than silently losing presentation.
      if (recordValue?.type === "event" && typeof sendPresentation !== "function") {
        return [{ type: "event", event: structuredClone(recordValue.event) }];
      }
      if (recordValue?.type === "intent_outcome" && recordValue.outcome) {
        return [{ type: "intent_outcome", outcome: structuredClone(recordValue.outcome) }];
      }
      // Review custody is semantic evidence. Do not filter it out of the frame:
      // detached renderers recover these same retained entries from attach.
      if (recordValue?.type === "queue_restoration") return [structuredClone(recordValue)];
      return [];
    });
  }

  function createSemanticFrame(records = [], directSnapshot = undefined) {
    const terminalSnapshot = semanticSnapshot(directSnapshot);
    observeSnapshotMutation(terminalSnapshot);
    const transportSequence = ++semanticTransportSequence;
    return {
      owner: semanticOwner(),
      transportSequence,
      frameId: `${hostInstanceId}:${sessionEpoch}:${transportSequence}`,
      records: authorityRecords(records),
      terminalSnapshot,
    };
  }

  // With a frame sink, a semantic change is emitted once as an opaque frame;
  // legacy records/snapshots remain only for callers that have not migrated.
  function commitSemanticFrame(records = [], full = false) {
    if (transition) {
      for (const item of records) record(item);
      return publishSnapshot(full);
    }
    if (typeof sendFrame === "function") {
      for (const _item of records) noteMutation();
      const frame = createSemanticFrame(records);
      sendFrame(frame);
      return frame;
    }
    const frame = createSemanticFrame(records);
    for (const item of records) record(item);
    sendControl({ type: "snapshot", snapshot: snapshot(), full });
    return frame;
  }

  function normalizedTreeBranch(value) {
    if (!Array.isArray(value)) return undefined;
    try {
      const branch = structuredClone(value);
      // Pi serializes a root entry's parent as null, while the public wire
      // contract represents a root by omitting parentId. Normalize that SDK
      // detail before validation so root-target navigation retains its branch.
      for (const entry of branch) {
        if (
          entry &&
          typeof entry === "object" &&
          !Array.isArray(entry) &&
          entry.parentId === null
        ) {
          delete entry.parentId;
        }
      }
      // Match SessionTreeEntrySchema's required wire identity fields before
      // retaining arbitrary entry extras. This keeps the outcome IPC-safe
      // without inventing an opaque branch payload.
      if (
        !branch.every(
          (entry) =>
            entry &&
            typeof entry === "object" &&
            !Array.isArray(entry) &&
            typeof entry.id === "string" &&
            typeof entry.type === "string" &&
            (entry.parentId === undefined || typeof entry.parentId === "string") &&
            (entry.timestamp === undefined ||
              typeof entry.timestamp === "string" ||
              typeof entry.timestamp === "number"),
        )
      ) {
        return undefined;
      }
      return branch;
    } catch {
      return undefined;
    }
  }

  // Intent outcomes are public protocol values, not an accidental projection
  // of arbitrary SDK return objects. Preserve only evidence the corresponding
  // typed schema names, while retaining error text at the outcome boundary.
  function typedIntentResult(intent, kind, result) {
    const value = result && typeof result === "object" ? result : {};
    switch (kind) {
      case "interrupt":
        return {
          target: value.target ?? "editor",
          interrupted: value.disposition === "abort_requested",
        };
      case "submit":
        return {
          disposition: value.disposition ?? "completed",
          editorRevision: Number.isInteger(value.editorRevision) ? value.editorRevision : 0,
          ...(typeof value.queued === "boolean" ? { queued: value.queued } : {}),
          ...(typeof value.custodyId === "string" ? { custodyId: value.custodyId } : {}),
          ...(typeof value.message === "string" ? { message: value.message } : {}),
        };
      case "manageQueue":
        return {
          operation: intent?.operation ?? "remove",
          ...(typeof value.targetIntentId === "string"
            ? { targetIntentId: value.targetIntentId }
            : {}),
          ...(value.queue === "steer" || value.queue === "followUp" ? { queue: value.queue } : {}),
          ...(typeof value.message === "string" ? { message: value.message } : {}),
        };
      case "invokeCommand": {
        const commandType =
          typeof intent?.text === "string"
            ? intent.text.replace(/^\//, "").trim().split(/\s+/, 1)[0]
            : undefined;
        return {
          ...(commandType ? { commandType } : {}),
          ...(typeof value.disposition === "string" ? { disposition: value.disposition } : {}),
          ...(Number.isInteger(value.editorRevision)
            ? { editorRevision: value.editorRevision }
            : {}),
          ...(typeof value.queued === "boolean" ? { queued: value.queued } : {}),
          ...(typeof value.custodyId === "string" ? { custodyId: value.custodyId } : {}),
          ...(typeof value.message === "string" ? { message: value.message } : {}),
          ...(value.response !== undefined ? { response: structuredClone(value.response) } : {}),
        };
      }
      case "compact":
        return {
          ...(typeof value.compactionId === "string" ? { compactionId: value.compactionId } : {}),
          ...(Number.isInteger(value.attempt) ? { attempt: value.attempt } : {}),
        };
      case "runBash":
        return {
          started: true,
          ...(typeof value.output === "string" ? { output: value.output } : {}),
          ...(Number.isInteger(value.exitCode) ? { exitCode: value.exitCode } : {}),
          ...(typeof value.cancelled === "boolean" ? { cancelled: value.cancelled } : {}),
          ...(typeof value.truncated === "boolean" ? { truncated: value.truncated } : {}),
        };
      case "navigate": {
        const cancelled = value.cancelled === true || value.aborted === true;
        const branch = !cancelled ? normalizedTreeBranch(value.branch) : undefined;
        return {
          targetId: intent?.targetId ?? value.targetId ?? "unknown",
          ...(typeof value.summarized === "boolean" ? { summarized: value.summarized } : {}),
          // Cancellation leaves Pi's active branch unchanged. Do not attach
          // stale/fabricated post-navigation data to that terminal outcome.
          ...(!cancelled && typeof value.editorText === "string"
            ? { editorText: value.editorText }
            : {}),
          ...(!cancelled && (typeof value.leafId === "string" || value.leafId === null)
            ? { leafId: value.leafId }
            : {}),
          ...(branch ? { branch } : {}),
        };
      }
      case "setModel":
        return {
          provider: value.provider ?? intent?.provider ?? "",
          modelId: value.modelId ?? intent?.modelId ?? "unknown",
        };
      case "setThinking":
        return { level: value.level ?? intent?.level ?? "off" };
      case "rename":
        return { name: value.name ?? intent?.name ?? "" };
      case "reload":
        return value.successorIdentity ? { successorIdentity: value.successorIdentity } : {};
      case "refreshModels":
        return value.refreshed === true ? { refreshed: true } : undefined;
      case "loginProvider":
        return typeof value.providerId === "string" &&
          value.providerId.length > 0 &&
          ["oauth", "api_key"].includes(value.authType)
          ? { providerId: value.providerId, authType: value.authType }
          : undefined;
      default:
        return undefined;
    }
  }

  function predecessorTerminalSnapshot(outcome) {
    const base = structuredClone(transition?.priorSemanticSnapshot);
    if (!base) return undefined;
    // This snapshot is deliberately a predecessor projection. It is only
    // enriched with the one terminal record that causally settled after the
    // replacement began; no successor SDK facts can leak into it.
    base.snapshotSequence = ++snapshotSequence;
    base.capturedAt = Date.now();
    base.activeIntents = base.activeIntents.filter((item) => item.intentId !== outcome.intentId);
    base.recentIntentOutcomes = [
      ...base.recentIntentOutcomes.filter((item) => item.intentId !== outcome.intentId),
      structuredClone(outcome),
    ].slice(-Math.max(1, Number(recentOutcomeCapacity) || 1));
    return base;
  }

  function publishPredecessorOutcome(outcome) {
    const terminalSnapshot = predecessorTerminalSnapshot(outcome);
    if (terminalSnapshot && typeof sendFrame === "function") {
      const transportSequence = ++semanticTransportSequence;
      sendFrame({
        owner: structuredClone(outcome.owner),
        transportSequence,
        frameId: `${outcome.owner.hostInstanceId}:${outcome.owner.sessionEpoch}:${transportSequence}`,
        records: [{ type: "intent_outcome", outcome: structuredClone(outcome) }],
        terminalSnapshot,
      });
      return;
    }
    // Compatibility consumers cannot accept an old-owner record in a
    // successor batch either. Keep it live and owner-tagged.
    sendRecord({ type: "intent_outcome", outcome: structuredClone(outcome) });
  }

  function settleDispatchedIntent(intentId, owner, kind, state, result) {
    const key = intentOwnerKey(owner, intentId);
    const entry = dispatchedIntents.get(key);
    if (!entry || entry.outcome) return entry?.outcome;
    const normalizedResult = typedIntentResult(entry.intent, kind, result);
    const error =
      state === "failed" || state === "outcome_unknown" || state === "rejected"
        ? typeof result?.message === "string"
          ? result.message
          : undefined
        : undefined;
    const outcome = {
      intentId,
      owner: structuredClone(owner),
      kind,
      state,
      ...(normalizedResult === undefined ? {} : { result: normalizedResult }),
      ...(error ? { error } : {}),
    };
    entry.outcome = outcome;
    if (
      entry.observedOperationId &&
      owner.hostInstanceId === hostInstanceId &&
      owner.sessionEpoch === sessionEpoch
    ) {
      observedOperation(
        "command",
        state === "completed"
          ? "completed"
          : state === "cancelled"
            ? "aborted"
            : state === "outcome_unknown"
              ? "unknown"
              : "failed",
        { operationId: entry.observedOperationId, intentId },
      );
    }
    // Terminal receipts must not pin the original command text or image bytes.
    entry.intent = retainedDispatchedIntent(entry.intent);
    pruneDispatchedIntents();
    if (owner.hostInstanceId === hostInstanceId && owner.sessionEpoch === sessionEpoch) {
      appendOperation({
        journalType: "intent_outcome",
        owner: structuredClone(owner),
        outcome: structuredClone(outcome),
      });
    }
    // Rebinding changes the child epoch before runtime.newSession/fork return.
    // Emit the initiating predecessor outcome live against the frozen old
    // baseline; folding it into the successor frame violates frame ownership.
    if (
      transition &&
      owner.hostInstanceId === transition.priorSemanticSnapshot.owner.hostInstanceId &&
      owner.sessionEpoch === transition.priorSemanticSnapshot.owner.sessionEpoch &&
      (owner.hostInstanceId !== hostInstanceId || owner.sessionEpoch !== sessionEpoch)
    ) {
      publishPredecessorOutcome(outcome);
    } else if (
      !transition &&
      (owner.hostInstanceId !== hostInstanceId || owner.sessionEpoch !== sessionEpoch)
    ) {
      // A delayed predecessor callback is no longer routable after successor
      // installation. Its initiating intent is settled before commit below;
      // never manufacture an invalid mixed-owner successor frame here.
      sendRecord({ type: "intent_outcome", outcome: structuredClone(outcome) });
    } else {
      commitSemanticFrame([{ type: "intent_outcome", outcome }]);
    }
    return outcome;
  }

  function settleTransitionInitiator(intentId, result = {}) {
    if (!transition || typeof intentId !== "string") return undefined;
    const owner = {
      hostInstanceId: transition.priorSemanticSnapshot.owner.hostInstanceId,
      sessionEpoch: transition.priorSemanticSnapshot.owner.sessionEpoch,
    };
    const entry = dispatchedIntents.get(intentOwnerKey(owner, intentId));
    if (!entry || entry.outcome) return entry?.outcome;
    const state =
      result?.cancelled === true || result?.aborted === true ? "cancelled" : "completed";
    return settleDispatchedIntent(intentId, owner, entry.kind, state, result);
  }

  function settleDispatchedSubmission(result) {
    const owner = {
      hostInstanceId: result.hostInstanceId,
      sessionEpoch: result.sessionEpoch,
    };
    const key = intentOwnerKey(owner, result.intentId);
    const entry = dispatchedIntents.get(key);
    if (!entry) return;
    const states = {
      completed: "completed",
      rejected: "rejected",
      not_submitted: "rejected",
      extension_error: "failed",
      outcome_unknown: "outcome_unknown",
    };
    const state = states[result.disposition];
    if (state) settleDispatchedIntent(result.intentId, owner, entry.kind, state, result);
  }

  function reportSubmission(result) {
    retainIntentOutcome(result);
    settleDispatchedSubmission(result);
    const submissionRecord = { type: "submission", result };
    // A forced predecessor settlement must never be folded into a successor's
    // atomic transition batch. Publish it on the live transition channel so
    // main can convert the old-epoch intent to review without invalidating the
    // successor batch identity.
    if (transition && result.sessionEpoch !== transition.provisionalEpoch) {
      noteMutation();
      sendRecord(submissionRecord);
    } else if (typeof sendFrame !== "function") {
      // The frame path already emitted the terminal intent_outcome above.
      // Publishing the compatibility submission again would create a second
      // terminal semantic commit with no typed record.
      record(submissionRecord);
    }
    onSubmissionResult(result);
  }

  // Called by host.mjs before it puts a transition-sensitive message on IPC.
  // Returning true means it was retained in the atomic batch and MUST NOT use
  // a transport sequence number yet.
  function captureOutbound(message) {
    if (closePreparation?.confirmed) {
      return !(message?.type === "response" && message.closeConfirmation === true);
    }
    if (
      transition &&
      message?.type === "submission_disposition" &&
      message.result?.sessionEpoch !== transition.provisionalEpoch
    ) {
      return { live: true, provisionalEpoch: transition.provisionalEpoch };
    }
    // Outcome records retain their original owner. Never fold a predecessor
    // result into a successor transition batch where compatibility consumers
    // could mistake it for successor semantic state.
    if (transition && message?.type === "intent_outcome") {
      return { live: true, provisionalEpoch: transition.provisionalEpoch };
    }
    const mutates =
      message?.type === "event" ||
      message?.type === "extension_ui_request" ||
      message?.type === "unified_submit_request" ||
      message?.type === "submission_disposition" ||
      message?.type === "intent_outcome" ||
      message?.type === "queue_restoration" ||
      (typeof message?.type === "string" && message.type.startsWith("panel_"));
    if (mutates) noteMutation();
    if (!transition) return false;
    let value;
    if (message?.type === "event") value = { type: "event", event: message.event };
    else if (message?.type === "extension_ui_request") value = { type: "ui", request: message };
    else if (
      typeof message?.type === "string" &&
      (message.type.startsWith("panel_") || message.type === "panel_clear_all")
    ) {
      value = { type: "panel", event: message };
    } else if (message?.type === "submission_disposition") {
      value = { type: "submission", result: message.result };
    } else if (message?.type === "intent_outcome") {
      value = { type: "intent_outcome", outcome: message.outcome };
    } else if (message?.type === "queue_restoration") {
      value = {
        type: "queue_restoration",
        restorationId: message.restorationId,
        steering: Array.isArray(message.steering) ? message.steering : [],
        followUp: Array.isArray(message.followUp) ? message.followUp : [],
        originalAttachments: Array.isArray(message.originalAttachments)
          ? message.originalAttachments
          : [],
        clearedIntentIds: Array.isArray(message.clearedIntentIds) ? message.clearedIntentIds : [],
        certainty: "unknown",
      };
    }
    if (!value) return false;
    // Dialogs and panel frames can be needed to unblock the operation that is
    // itself crossing the boundary (notably custom() and select()). Publish
    // them live, tagged with the target epoch, while retaining an audit entry.
    // Commit filters that entry so the renderer never sees the frame twice.
    if (value.type === "ui" || value.type === "panel") {
      value.provisionalPublished = true;
      transition.records.push(value);
      return { provisionalEpoch: transition.provisionalEpoch, live: true };
    }
    transition.records.push(value);
    return true;
  }

  function resultFor(request, disposition, extra = {}) {
    return {
      intentId: request.intentId,
      hostInstanceId: request.expectedHostId,
      sessionEpoch: request.expectedEpoch,
      editorRevision: request.editorRevision,
      disposition,
      ...extra,
    };
  }

  async function waitForFenceIfIdle() {
    while (!session.isStreaming && promptFence) {
      try {
        await promptFence;
      } catch {
        // The preceding result is reported to its own intent. The fence still
        // prevents a second idle prompt until the promise has actually settled.
      }
    }
  }

  function acknowledgeEditorCustody(request) {
    if (request.expectedHostId !== hostInstanceId || request.expectedEpoch !== sessionEpoch) {
      return false;
    }
    return acceptEditorSubmission(request);
  }

  function rememberAttachments(request) {
    attachmentLedger.set(request.intentId, {
      intentId: request.intentId,
      requestedMode: request.requestedMode,
      text: request.text,
      images: structuredClone(request.images ?? []),
      ingressSequence: ++ingressSequence,
    });
  }

  async function admit(request, fromCustody = false) {
    if (
      request.expectedHostId !== hostInstanceId ||
      request.expectedEpoch !== sessionEpoch ||
      activeIntents.has(request.intentId)
    ) {
      return resultFor(request, "not_submitted", { message: "Runtime identity changed" });
    }
    if (transition) {
      return resultFor(request, "not_submitted", {
        message: "Session replacement is in progress",
      });
    }

    // The accepted editor revision is a host fact. A stale composer must never
    // cause prompt() to consume text that no longer corresponds to its draft.
    // Custody owns an already admitted GUI intent. Its editor revision may
    // legitimately advance while a compaction/navigation barrier runs; checking
    // it again here would strand that FIFO prefix forever.
    if (!fromCustody && request.editorRevision !== getEditor().revision) {
      return resultFor(request, "not_submitted", {
        message: "Editor revision changed before submission was accepted",
      });
    }

    if ((compactionBarrierOpen() || navigationDepth > 0) && !fromCustody) {
      const custodyId = crypto.randomUUID();
      custody.push({
        custodyId,
        request: structuredClone(request),
        ingressSequence: ++ingressSequence,
        barrierId: `barrier-${barrierSequence}`,
        phase: compactionBarrierOpen() ? "compaction" : "navigation",
      });
      activeIntents.set(request.intentId, "custody");
      acknowledgeEditorCustody(request);
      const value = resultFor(request, "in_custody", { custodyId });
      reportSubmission(value);
      publishSnapshot();
      return value;
    }

    if (!fromCustody && !session.isStreaming && promptFence) {
      const custodyId = crypto.randomUUID();
      custody.push({
        request: structuredClone(request),
        custodyId,
        ingressSequence: ++ingressSequence,
        barrierId: "prompt-fence",
        phase: "prompt_fence",
      });
      activeIntents.set(request.intentId, "custody");
      acknowledgeEditorCustody(request);
      void promptFence.finally(() => scheduleCustodyDrain()).catch(() => {});
      const value = resultFor(request, "in_custody", { custodyId });
      reportSubmission(value);
      publishSnapshot();
      return value;
    }

    await waitForFenceIfIdle();
    // waitForFenceIfIdle() yields. A replacement may have started in that
    // interval; revalidate before creating prompt/preflight work against the
    // mutable current session.
    if (
      transition ||
      request.expectedHostId !== hostInstanceId ||
      request.expectedEpoch !== sessionEpoch
    ) {
      activeIntents.delete(request.intentId);
      return resultFor(request, "not_submitted", {
        message: "Session replacement started before prompt admission",
      });
    }
    const wasStreaming = session.isStreaming;
    const queueMode = request.requestedMode === "steer" ? "steer" : "followUp";
    const isSlashCommand = request.text.startsWith("/");
    const commandName = isSlashCommand ? request.text.slice(1).split(/\s/, 1)[0] : "";
    const isExtension = !!commandName && !!session.extensionRunner.getCommand(commandName);
    submitting++;
    activeIntents.set(request.intentId, "admitting");
    publishSnapshot();
    // publishSnapshot synchronizes extension/external queue mutations. The
    // attributable admission baseline must come from that fresh observation.
    const queueLengthBeforePrompt = queueLengths[queueMode];
    const queueValuesBeforePrompt = [...queueValues[queueMode]];

    let preflightResolve;
    let crossedPreflight = false;
    const preflight = new Promise((resolve) => {
      preflightResolve = resolve;
    });
    // preflightResult is public in Pi >= 0.80.6 (the host version gate below).
    const promptPromise = Promise.resolve().then(() =>
      runWithSurface(
        request.surface,
        () =>
          session.prompt(request.text, {
            ...(!isSlashCommand && request.images?.length ? { images: request.images } : {}),
            source: "interactive",
            streamingBehavior: request.requestedMode,
            preflightResult: (success) => {
              if (success) {
                crossedPreflight = true;
                // Correlate synchronously at Pi's acceptance boundary. Waiting
                // for the submit continuation leaves a re-entrant delivery
                // window where message_start has no queue intent.
                if (wasStreaming) {
                  registerQueuedIntent(request, queueLengthBeforePrompt, queueValuesBeforePrompt);
                } else {
                  directDeliveryIntentId = request.intentId;
                }
              }
              preflightResolve(success);
            },
          }),
        request.intentId,
      ),
    );
    if (!wasStreaming) promptFence = promptPromise;
    if (!wasStreaming) {
      void promptPromise
        .finally(() => {
          if (directDeliveryIntentId === request.intentId) directDeliveryIntentId = null;
        })
        .catch(() => {});
    }
    if (wasStreaming) {
      // Register this before any admission continuation so all prompt() exit
      // paths (handled extension, rejection, throw, or normal queueing) take a
      // final queue observation and cannot leave a stale positional claim.
      void promptPromise
        .then(
          () =>
            finalizeQueuedIntentClaim(request, queueLengthBeforePrompt, queueValuesBeforePrompt),
          () =>
            finalizeQueuedIntentClaim(request, queueLengthBeforePrompt, queueValuesBeforePrompt),
        )
        .catch(() => pendingQueueClaims.delete(request.intentId));
    }

    const admissionDeadline = new Promise((resolve) => {
      setTimeout(() => resolve("deadline"), 2_000).unref?.();
    });
    const preflightOutcome = preflight.then((ok) => (ok ? "preflight" : "rejected"));
    const promptOutcome = promptPromise.then(
      () => "settled",
      () => "failed",
    );

    try {
      // Streaming observation alone is never a consumption signal: on an
      // already-active turn it is merely the pre-existing turn, and on an idle
      // turn it can become visible before an extension preflight later rejects.
      // Idle admission requires successful preflight plus the public streaming
      // boundary, unless the prompt promise itself settles first.
      let winner = await Promise.race([preflightOutcome, promptOutcome, admissionDeadline]);
      if (winner === "preflight" && !wasStreaming) {
        let streamingPoll;
        const stateObserved = new Promise((resolve) => {
          const check = () => {
            if (session.isStreaming) return resolve("streaming");
            streamingPoll = setTimeout(check, 10);
            streamingPoll.unref?.();
          };
          check();
        });
        try {
          winner = await Promise.race([stateObserved, promptOutcome, admissionDeadline]);
        } finally {
          if (streamingPoll) clearTimeout(streamingPoll);
        }
      }
      if (winner === "rejected") {
        activeIntents.delete(request.intentId);
        return resultFor(request, "rejected", { message: "Prompt preflight rejected" });
      }
      if (winner === "failed") {
        try {
          await promptPromise;
        } catch (err) {
          activeIntents.delete(request.intentId);
          if (isExtension) acknowledgeEditorCustody(request);
          return resultFor(
            request,
            isExtension ? "extension_error" : crossedPreflight ? "outcome_unknown" : "rejected",
            {
              message: err instanceof Error ? err.message : String(err),
            },
          );
        }
      }
      if (winner === "deadline") {
        // The deadline is diagnostic only while this child still owns the
        // promise. Returning outcome_unknown here made a live admission look
        // terminal and then emitted a second completion later.
        activeIntents.set(request.intentId, "admitting");
        if (wasStreaming) rememberAttachments(request);
        unresolvedAdmissions++;
        const stuckTimer = setTimeout(() => {
          if (activeIntents.get(request.intentId) === "admitting") {
            onAdmissionStuck({ intentId: request.intentId, sessionEpoch });
          }
        }, admissionStuckMs);
        stuckTimer.unref?.();
        void promptPromise
          .then(
            () => {
              if (wasStreaming) {
                finalizeQueuedIntentClaim(
                  request,
                  queueLengthBeforePrompt,
                  queueValuesBeforePrompt,
                );
              }
              acknowledgeEditorCustody(request);
              activeIntents.delete(request.intentId);
              reportSubmission(resultFor(request, "completed", { queued: wasStreaming }));
              publishSnapshot();
            },
            (err) => {
              activeIntents.delete(request.intentId);
              if (isExtension) acknowledgeEditorCustody(request);
              reportSubmission(
                resultFor(
                  request,
                  isExtension
                    ? "extension_error"
                    : crossedPreflight
                      ? "outcome_unknown"
                      : "rejected",
                  { message: err instanceof Error ? err.message : String(err) },
                ),
              );
              publishSnapshot();
            },
          )
          .finally(() => {
            clearTimeout(stuckTimer);
            unresolvedAdmissions--;
          });
        return resultFor(request, "admitting", {
          message: "Prompt admission is still pending in this authority",
        });
      }

      activeIntents.set(request.intentId, "consumed");
      acknowledgeEditorCustody(request);
      if (wasStreaming) {
        registerQueuedIntent(request, queueLengthBeforePrompt, queueValuesBeforePrompt);
        rememberAttachments(request);
      }
      const consumed = resultFor(request, "consumed", { queued: wasStreaming });
      void promptPromise.then(
        () => {
          activeIntents.delete(request.intentId);
          reportSubmission(resultFor(request, "completed", { queued: wasStreaming }));
          publishSnapshot();
        },
        (err) => {
          activeIntents.delete(request.intentId);
          reportSubmission(
            resultFor(request, isExtension ? "extension_error" : "outcome_unknown", {
              message: err instanceof Error ? err.message : String(err),
            }),
          );
          publishSnapshot();
        },
      );
      return consumed;
    } finally {
      submitting--;
      if (promptFence === promptPromise) {
        void promptPromise
          .finally(() => {
            if (promptFence === promptPromise) promptFence = null;
          })
          .catch(() => {});
      }
      publishSnapshot();
    }
  }

  /**
   * Target SessionIntent ingress. The receipt says only that this child wrote
   * an owner-bound intent record and accepted execution responsibility. The
   * terminal outcome is emitted later as an authority semantic record.
   */
  function dispatchIntent(envelope, execute) {
    const intent = envelope?.intent;
    const owner = envelope?.expectedOwner;
    const intentId = envelope?.intentId;
    // Validate before fingerprinting, retention, journal admission, or any
    // scheduler work. The typed renderer/main contract is not a substitute for
    // this hostile child IPC boundary.
    if (
      typeof intentId !== "string" ||
      intentId.length === 0 ||
      !owner ||
      typeof owner.hostInstanceId !== "string" ||
      owner.hostInstanceId.length === 0 ||
      !Number.isInteger(owner.sessionEpoch) ||
      owner.sessionEpoch < 0 ||
      !isValidSessionIntent(intent)
    ) {
      return Promise.resolve({
        status: "not_admitted",
        intentId: typeof intentId === "string" ? intentId : "",
        reason: "invalid",
        invalidReason: "malformed",
      });
    }
    if (owner.hostInstanceId !== hostInstanceId || owner.sessionEpoch !== sessionEpoch) {
      return Promise.resolve({ status: "not_admitted", intentId, reason: "stale_owner" });
    }
    if (stopped || closePreparation?.confirmed) {
      return Promise.resolve({ status: "not_admitted", intentId, reason: "closing" });
    }
    if (transition) {
      return Promise.resolve({ status: "not_admitted", intentId, reason: "transitioning" });
    }

    const key = intentOwnerKey(owner, intentId);
    const payloadBytes = intentPayloadBytes(intent);
    const payloadLimit = Math.max(1, Number(dispatchedIntentPayloadBytes) || 1);
    if (payloadBytes > payloadLimit) {
      return Promise.resolve({
        status: "not_admitted",
        intentId,
        reason: "invalid",
        invalidReason: "payload_too_large",
      });
    }
    // A digest retains duplicate protection without retaining payload/image bytes.
    const fingerprint = crypto
      .createHash("sha256")
      .update(stableFingerprint({ owner, intent }))
      .digest("hex");
    const prior = dispatchedIntents.get(key);
    if (prior) {
      if (prior.fingerprint !== fingerprint) {
        return Promise.resolve({ status: "not_admitted", intentId, reason: "invalid" });
      }
      return Promise.resolve({ status: "duplicate", intentId, owner: structuredClone(owner) });
    }

    // This write happens before scheduling any possible SDK call. The bounded
    // operation journal therefore has a durable admission boundary even if the
    // child dies during dispatch. Refuse rather than dropping unsettled work.
    const intentCapacity = Math.max(1, Number(dispatchedIntentCapacity) || 1);
    // Make room only by retiring already-settled receipts; unsettled work is
    // never silently forgotten merely to admit another intent.
    const terminal = [...dispatchedIntents.entries()]
      .filter(([, entry]) => entry.outcome)
      .sort(([, a], [, b]) => a.recordSequence - b.recordSequence);
    while (dispatchedIntents.size >= intentCapacity && terminal.length > 0) {
      const [terminalKey] = terminal.shift();
      dispatchedIntents.delete(terminalKey);
      dispatchedIntentTruncated = true;
    }
    if (dispatchedIntents.size >= intentCapacity) {
      return Promise.resolve({
        status: "not_admitted",
        intentId,
        reason: "invalid",
        invalidReason: "capacity",
      });
    }
    const entry = {
      intentId,
      fingerprint,
      kind: intent.kind,
      intent: structuredClone(intent),
      owner: structuredClone(owner),
      recordedAt: Date.now(),
      recordSequence: ++nextDispatchedIntentSequence,
      outcome: null,
    };
    dispatchedIntents.set(key, entry);
    commitSemanticFrame([{ type: "intent_admitted", intentId, owner, kind: intent.kind }]);

    const settleFromResult = (result) => {
      // submit/invokeCommand settle when their existing child admission
      // lifecycle produces a terminal submission result. Immediate refusal
      // is terminal here; consumed/custody are not completion.
      if (intent.kind === "submit" || intent.kind === "invokeCommand") {
        const disposition = result?.disposition;
        if (["consumed", "in_custody", "admitting"].includes(disposition)) return;
        const state =
          disposition === "outcome_unknown"
            ? "outcome_unknown"
            : disposition === "extension_error"
              ? "failed"
              : disposition === "rejected" || disposition === "not_submitted"
                ? "rejected"
                : "completed";
        settleDispatchedIntent(intentId, owner, intent.kind, state, result);
        return;
      }
      if (intent.kind === "manageQueue") {
        const state =
          result?.uncertain === true
            ? "outcome_unknown"
            : result?.applied === true
              ? "completed"
              : "rejected";
        settleDispatchedIntent(intentId, owner, intent.kind, state, result);
        return;
      }
      const state =
        result?.cancelled === true || result?.aborted === true ? "cancelled" : "completed";
      settleDispatchedIntent(intentId, owner, intent.kind, state, result);
    };
    const settleFromError = (error) => {
      // Authentication failures may contain provider responses or credential
      // hints. Its authority outcome is intentionally non-secret and bounded.
      settleDispatchedIntent(
        intentId,
        owner,
        intent.kind,
        "failed",
        intent.kind === "loginProvider"
          ? undefined
          : { message: error instanceof Error ? error.message : String(error) },
      );
    };
    // commitTransition already emitted the single successor baseline.
    // A trailing snapshot would create a second empty successor frame for
    // the predecessor's initiating intent.
    const publishIfOwner = () => {
      if (owner.hostInstanceId === hostInstanceId && owner.sessionEpoch === sessionEpoch) {
        publishSnapshot();
      }
    };

    void schedule("ingress", async () => {
      try {
        // Transitions never inherit queued ingress. Do not run a delayed
        // predecessor intent against a successor session.
        if (
          transition ||
          owner.hostInstanceId !== hostInstanceId ||
          owner.sessionEpoch !== sessionEpoch
        ) {
          settleDispatchedIntent(intentId, owner, intent.kind, "outcome_unknown", {
            message: "Intent execution lost its owning authority",
          });
          return;
        }
        if (intent.kind === "invokeCommand") {
          entry.observedOperationId = observedOperation("command", "invoking", {
            intentId,
            command: intent.text,
          });
        }
        const result = await execute(intent, owner);
        // A long-running SDK operation (compaction, bash, navigation) must
        // not hold this serialized scheduler until it completes: its
        // admission barrier is already open, and later ingress — prompts
        // entering custody, other intents — must keep flowing. The executor
        // returns { deferredOutcome } once the operation has started;
        // settlement follows that promise off-scheduler.
        if (result && typeof result.deferredOutcome?.then === "function") {
          void result.deferredOutcome
            .then(settleFromResult, settleFromError)
            .finally(publishIfOwner);
          return;
        }
        settleFromResult(result);
      } catch (error) {
        settleFromError(error);
      } finally {
        publishIfOwner();
      }
    });
    return Promise.resolve({ status: "admitted", intentId, owner: structuredClone(owner) });
  }

  function submit(request, alreadySerialized = false) {
    // Defense in depth: renderer classification already omits images for slash
    // commands, but the host must never forward an attachment payload if a
    // stale or malformed caller supplies one.
    const normalized = request.text.startsWith("/") ? { ...request, images: [] } : request;
    const fingerprint = intentFingerprint(normalized);
    const prior = intentLedger.get(normalized.intentId);
    if (prior) {
      if (prior.fingerprint !== fingerprint) {
        return Promise.resolve(
          resultFor(normalized, "rejected", {
            message: "Intent ID was reused with a different payload",
          }),
        );
      }
      // A retransmitted identical envelope is a receipt retry, never a second
      // SDK call. Once settled, expose the retained terminal outcome.
      if (prior.settled) return Promise.resolve(structuredClone(prior.terminal ?? prior.initial));
      return prior.promise;
    }
    const ledger = { fingerprint, settled: false, initial: null, terminal: null, promise: null };
    intentLedger.set(normalized.intentId, ledger);
    const admission = alreadySerialized
      ? Promise.resolve().then(() => admit(normalized))
      : schedule("ingress", () => admit(normalized));
    ledger.promise = admission.then(
      (result) => {
        ledger.initial = structuredClone(result);
        retainIntentOutcome(result);
        return result;
      },
      (error) => {
        // An adapter exception did not produce an authoritative disposition;
        // allow the caller to observe it but never leave a phantom dedupe key.
        intentLedger.delete(normalized.intentId);
        throw error;
      },
    );
    return ledger.promise;
  }

  async function drainCustody() {
    if (compactionBarrierOpen() || navigationDepth > 0 || custody.length === 0) return;
    custody.sort((a, b) => a.ingressSequence - b.ingressSequence);
    while (custody.length > 0 && !compactionBarrierOpen() && navigationDepth === 0) {
      if (!session.isStreaming && promptFence) {
        // A prior drained prompt crossed admission but has not settled. Never
        // block the single scheduler (and every later IPC) behind that fence;
        // leave the exact suffix in custody and resume from its head when the
        // promise settles.
        void promptFence.finally(() => scheduleCustodyDrain()).catch(() => {});
        break;
      }
      const item = custody[0];
      activeIntents.delete(item.request.intentId);
      const value = await admit(item.request, true);
      if (
        value.disposition === "consumed" ||
        value.disposition === "admitting" ||
        value.disposition === "completed" ||
        value.disposition === "extension_error"
      ) {
        custody.shift();
        reportSubmission(value);
      } else if (value.disposition === "outcome_unknown") {
        // The original prompt may already have crossed the consumption
        // boundary. Move it permanently to review-only restoration; leaving it
        // in custody would let a later barrier execute it a second time.
        restoreCustody(
          [item],
          "Custody admission is uncertain; review this submission before retrying",
        );
      } else {
        // Keep the exact prefix recoverable. Its active marker is restored so
        // duplicate GUI ingress cannot silently replace it.
        activeIntents.set(item.request.intentId, "custody");
        break;
      }
    }
    publishSnapshot();
  }

  function scheduleCustodyDrain() {
    if (compactionBarrierOpen() || navigationDepth > 0 || custody.length === 0) return;
    void schedule("custody", drainCustody);
  }

  function presentationCursor(plane) {
    const transportSequence = ++presentationTransportSequence[plane];
    return {
      ...semanticOwner(),
      transportSequence,
      snapshotSequence: Math.max(1, snapshotSequence),
    };
  }

  function publishTranscript(entries) {
    if (typeof sendPresentation !== "function") return;
    const cursor = presentationCursor("transcript");
    transcriptPresentation.liveTailCursor = String(cursor.transportSequence);
    const event = entries[entries.length - 1];
    if (event?.type === "message_start" || event?.type === "message_update") {
      transcriptPresentation.currentStreamingMessage = structuredClone(event.message ?? event);
    } else if (event?.type === "message_end") {
      transcriptPresentation.currentStreamingMessage = undefined;
    }
    sendPresentation({
      plane: "transcript",
      owner: semanticOwner(),
      payload: {
        kind: "delta",
        cursor,
        liveTailCursor: transcriptPresentation.liveTailCursor,
        entries: structuredClone(entries),
      },
    });
  }

  function publishExtensionUi(request) {
    if (typeof sendPresentation !== "function") return;
    const cursor = presentationCursor("extensionUi");
    sendPresentation({
      plane: "extensionUi",
      owner: semanticOwner(),
      payload: { kind: "request", cursor, request: structuredClone(request) },
    });
  }

  function publishPanel(payload) {
    if (typeof sendPresentation !== "function") return;
    const cursor = presentationCursor("panel");
    const owner = semanticOwner();
    const resolved =
      typeof payload === "function"
        ? payload(structuredClone(cursor), structuredClone(owner))
        : { ...payload, cursor };
    sendPresentation({ plane: "panel", owner, payload: resolved });
  }

  function observeEvent(event) {
    // clearQueue() and the public requeue methods synchronously emit one
    // queue_update each. A management transaction rebuilds the complete queue
    // in the same JS turn, so publishing those transient empty/partial states
    // would make a single atomic user operation visibly flicker.
    if (queueMutationActive && event?.type === "queue_update") return undefined;
    let publishedEvent = event;
    if (event?.type === "message_start" && event.message?.role === "user") {
      const { deliveredQueueIntentIds } = readQueues(true);
      // More than one removal for one event is ambiguous; retire all rather
      // than assigning an arbitrary GUI intent.
      const queuedIntentId =
        deliveredQueueIntentIds.length === 1 ? deliveredQueueIntentIds[0] : undefined;
      const queueIntentId = queuedIntentId ?? directDeliveryIntentId ?? undefined;
      if (!queuedIntentId && directDeliveryIntentId === queueIntentId) {
        directDeliveryIntentId = null;
      }
      if (queueIntentId) publishedEvent = { ...event, queueIntentId };
    }
    if (event?.type === "agent_start") {
      const retryId = activeOperationId("retry");
      if (retryId) observedOperation("retry", "completed", { operationId: retryId });
      observedOperation("agent", "active");
    } else if (event?.type === "agent_end") {
      const agentId = activeOperationId("agent") ?? observedOperation("agent", "started");
      observedOperation(
        "agent",
        event.aborted === true
          ? "aborted"
          : typeof event.errorMessage === "string"
            ? "failed"
            : "completed",
        { operationId: agentId, ...(event.errorMessage ? { detail: event.errorMessage } : {}) },
      );
      if (event.willRetry === true) observedOperation("retry", "retry_wait");
    }
    if (event?.type === "compaction_start") {
      const retrying = compaction.phase === "retry_wait";
      const reconcileToken = ++compactionGetterReconcileToken;
      compactionGetterReconcilePending = true;
      compaction = {
        phase: "active",
        operationId: retrying ? compaction.operationId : crypto.randomUUID(),
        origin: "event",
        attempt: retrying ? compaction.attempt + 1 : Math.max(1, compaction.attempt + 1),
        anomaly: null,
        invocationPending: compaction.invocationPending === true,
      };
      barrierSequence++;
      observedOperation("compaction", "active", { operationId: compaction.operationId });
      queueMicrotask(() => {
        if (stopped || reconcileToken !== compactionGetterReconcileToken) return;
        compactionGetterReconcilePending = false;
        reconcileCompactionGetter();
        actualCompaction = compactionBarrierOpen();
        publishSnapshot();
      });
    } else if (event?.type === "compaction_end") {
      const failed = event.aborted === true || typeof event.errorMessage === "string";
      const reconcileToken = ++compactionGetterReconcileToken;
      compactionGetterReconcilePending = true;
      if (event.willRetry === true) {
        // Keep the barrier closed between retry attempts so new ingress joins
        // custody rather than overtaking the retained prefix.
        compaction = { ...compaction, phase: "retry_wait", anomaly: null };
        observedOperation("compaction", "retry_wait", { operationId: compaction.operationId });
      } else {
        compaction = {
          ...compaction,
          phase: failed
            ? event.aborted === true
              ? "terminal_aborted"
              : "terminal_failed"
            : "terminal_success",
          anomaly: null,
        };
        observedOperation(
          "compaction",
          failed ? (event.aborted === true ? "aborted" : "failed") : "completed",
          {
            operationId: compaction.operationId,
            ...(failed && typeof event.errorMessage === "string"
              ? { detail: event.errorMessage }
              : {}),
          },
        );
      }
      // Pi clears isCompacting in the finally block immediately after this
      // synchronous event callback. Sample that direct getter in a microtask;
      // until then the explicit settlement barrier prevents later ingress from
      // overtaking compaction custody.
      queueMicrotask(() => {
        if (stopped || reconcileToken !== compactionGetterReconcileToken) return;
        compactionGetterReconcilePending = false;
        reconcileCompactionGetter();
        actualCompaction = compactionBarrierOpen();
        if (!actualCompaction) {
          if (failed) {
            restoreCustody(
              custody.filter((item) => item.phase === "compaction"),
              "Compaction ended without success; review this submission before retrying",
            );
          } else {
            scheduleCustodyDrain();
          }
        }
        publishSnapshot();
      });
    }
    actualCompaction = compactionBarrierOpen();
    // Production publishes the event exactly once on its independently
    // sequenced transcript plane. Keep the legacy record+snapshot fallback for
    // embedders/tests that have not installed a presentation sink.
    if (typeof sendPresentation === "function") {
      const frame = commitSemanticFrame([]);
      publishTranscript([publishedEvent]);
      return frame;
    }
    return commitSemanticFrame([{ type: "event", event: publishedEvent }]);
  }

  function restoreCustody(items, message) {
    if (items.length === 0) return;
    const cancelledIds = new Set(items.map((item) => item.custodyId));
    for (let index = custody.length - 1; index >= 0; index--) {
      if (cancelledIds.has(custody[index].custodyId)) custody.splice(index, 1);
    }
    const restorationId = crypto.randomUUID();
    const restoration = {
      type: "queue_restoration",
      restorationId,
      steering: items
        .filter((item) => item.request.requestedMode === "steer")
        .map((item) => item.request.text),
      followUp: items
        .filter((item) => item.request.requestedMode !== "steer")
        .map((item) => item.request.text),
      originalAttachments: items.map((item) => ({
        intentId: item.request.intentId,
        images: structuredClone(item.request.images ?? []),
      })),
      certainty: "not_processed",
    };
    restorations.set(restorationId, restoration);
    record(restoration);
    for (const item of items) {
      activeIntents.set(item.request.intentId, "unknown");
      reportSubmission(
        resultFor(item.request, "outcome_unknown", {
          message,
        }),
      );
    }
  }

  function restoreCancelledNavigationCustody(barrierId, message) {
    restoreCustody(
      custody.filter((item) => item.phase === "navigation" && item.barrierId === barrierId),
      message,
    );
  }

  async function runNavigation(fn) {
    navigationDepth++;
    const navigationBarrierId = `barrier-${++barrierSequence}`;
    const navigationOperationId = observedOperation("navigation", "started");
    publishSnapshot();
    let shouldDrain = true;
    try {
      const result = await fn();
      if (result?.cancelled === true || result?.aborted === true) {
        observedOperation("navigation", "aborted", { operationId: navigationOperationId });
        shouldDrain = false;
        restoreCancelledNavigationCustody(
          navigationBarrierId,
          "Navigation was cancelled; review this submission before retrying",
        );
      } else {
        observedOperation("navigation", "completed", { operationId: navigationOperationId });
      }
      return result;
    } catch (error) {
      observedOperation("navigation", "failed", {
        operationId: navigationOperationId,
        detail: error instanceof Error ? error.message : String(error),
      });
      shouldDrain = false;
      restoreCancelledNavigationCustody(
        navigationBarrierId,
        "Navigation failed; review this submission before retrying",
      );
      throw error;
    } finally {
      navigationDepth--;
      publishSnapshot();
      if (shouldDrain || navigationDepth === 0) scheduleCustodyDrain();
    }
  }

  function sameQueueIntentIds(actual, expected) {
    return (
      actual.length === expected.length &&
      actual.every((intentId, index) => intentId === expected[index])
    );
  }

  function queueManagementAvailability(steering, followUp) {
    if (pendingQueueClaims.size > 0) {
      return {
        available: false,
        message: "A queued prompt is still being admitted; try again once it appears.",
      };
    }
    const inspect = (mode, texts, intentIds) => {
      if (texts.length !== intentIds.length) {
        return "Queue ownership is synchronizing; try again once it settles.";
      }
      for (const [index, text] of texts.entries()) {
        const intentId = intentIds[index];
        if (typeof intentId !== "string") {
          return "This queue also contains an instruction managed outside Pi-Vis, so it cannot be safely changed here.";
        }
        const payload = queuedPayloads.get(intentId);
        if (!payload || payload.requestedMode !== mode || payload.replayable !== true) {
          return "Only plain Pi-Vis prompts can be changed while queued.";
        }
        // Pi only exposes transformed queue text, and it does not expose queued
        // image identities. Replaying either through steer()/followUp() could
        // change delivery, so only an exact original plain-text payload is safe.
        if (payload.text !== text) {
          return "A pending instruction was transformed before queuing and cannot be safely changed here.";
        }
        if (payload.images.length > 0) {
          return "A pending instruction has attachments and cannot be safely changed here.";
        }
      }
      return undefined;
    };
    const steeringMessage = inspect("steer", steering, queueIdentity.steer);
    if (steeringMessage) return { available: false, message: steeringMessage };
    const followUpMessage = inspect("followUp", followUp, queueIdentity.followUp);
    if (followUpMessage) return { available: false, message: followUpMessage };
    return { available: true };
  }

  function inspectManageableQueues() {
    const { steering, followUp } = readQueues();
    const availability = queueManagementAvailability(steering, followUp);
    if (!availability.available) return availability;
    const entries = (mode, texts, intentIds) =>
      texts.map((text, index) => {
        const intentId = intentIds[index];
        return {
          intentId,
          text,
          payload: structuredClone(queuedPayloads.get(intentId)),
        };
      });
    return {
      ...availability,
      steering,
      followUp,
      steeringEntries: entries("steer", steering, queueIdentity.steer),
      followUpEntries: entries("followUp", followUp, queueIdentity.followUp),
    };
  }

  function queueManagementResult(operation, extra = {}) {
    return { operation, ...extra };
  }

  /**
   * Pi's public SDK exposes queue reads and clearQueue(), but no per-item
   * mutation. Under the strict ownership proof above, clear-and-rebuild is
   * safe: all queue mutations happen synchronously in this host's JS turn,
   * so the agent loop cannot consume an intermediate empty/partial queue.
   */
  async function manageQueue(intent) {
    const operation = intent.operation;
    const current = inspectManageableQueues();
    if (!current.steeringEntries || !current.followUpEntries) {
      return queueManagementResult(operation, { message: current.message });
    }

    if (
      operation === "clear" &&
      (!sameQueueIntentIds(queueIdentity.steer, intent.expectedSteeringIntentIds ?? []) ||
        !sameQueueIntentIds(queueIdentity.followUp, intent.expectedFollowUpIntentIds ?? []))
    ) {
      return queueManagementResult(operation, {
        message: "The pending queue changed before it could be cleared. Review it and try again.",
      });
    }

    const steeringEntries = current.steeringEntries.map((entry) => structuredClone(entry));
    const followUpEntries = current.followUpEntries.map((entry) => structuredClone(entry));
    const allEntries = [...steeringEntries, ...followUpEntries];
    const targetIntentId = intent.targetIntentId;
    let targetQueue;
    let targetIndex = -1;
    if (operation !== "clear") {
      targetQueue = steeringEntries.findIndex((entry) => entry.intentId === targetIntentId);
      if (targetQueue >= 0) {
        targetIndex = targetQueue;
        targetQueue = "steer";
      } else {
        const followUpIndex = followUpEntries.findIndex(
          (entry) => entry.intentId === targetIntentId,
        );
        if (followUpIndex < 0) {
          return queueManagementResult(operation, {
            ...(targetIntentId ? { targetIntentId } : {}),
            message: "That instruction was already delivered or removed.",
          });
        }
        targetIndex = followUpIndex;
        targetQueue = "followUp";
      }
    }

    if (operation === "remove") {
      const entries = targetQueue === "steer" ? steeringEntries : followUpEntries;
      entries.splice(targetIndex, 1);
    } else if (operation === "update") {
      const entries = targetQueue === "steer" ? steeringEntries : followUpEntries;
      const entry = entries[targetIndex];
      if (!entry) {
        return queueManagementResult(operation, {
          ...(targetIntentId ? { targetIntentId } : {}),
          message: "That instruction was already delivered or removed.",
        });
      }
      entry.payload.text = intent.text;
    } else if (operation === "move") {
      const entries = targetQueue === "steer" ? steeringEntries : followUpEntries;
      const replacementIndex = intent.direction === "earlier" ? targetIndex - 1 : targetIndex + 1;
      if (replacementIndex < 0 || replacementIndex >= entries.length) {
        return queueManagementResult(operation, {
          ...(targetIntentId ? { targetIntentId } : {}),
          queue: targetQueue,
          message:
            intent.direction === "earlier"
              ? "That instruction is already next."
              : "That instruction is already last.",
        });
      }
      const [entry] = entries.splice(targetIndex, 1);
      entries.splice(replacementIndex, 0, entry);
    } else if (operation === "clear") {
      steeringEntries.length = 0;
      followUpEntries.length = 0;
    }

    const nextEntries = [...steeringEntries, ...followUpEntries];
    const enqueue = (entry) =>
      runWithSurface(
        entry.payload.surface,
        () =>
          entry.payload.requestedMode === "steer"
            ? session.steer(entry.payload.text, entry.payload.images)
            : session.followUp(entry.payload.text, entry.payload.images),
        entry.intentId,
      );
    const queueIds = (entries) => entries.map((entry) => entry.intentId);
    const allCurrentIntentIds = allEntries.map((entry) => entry.intentId);

    queueMutationActive = true;
    let enqueuePromises = [];
    try {
      session.clearQueue();
      if (
        session.getSteeringMessages().length !== 0 ||
        session.getFollowUpMessages().length !== 0
      ) {
        throw new Error("The SDK did not clear its pending queue");
      }
      // Call every public enqueue method before awaiting any promise. Their
      // bodies synchronously push into Pi's queue, preserving the complete
      // queue before the event loop can run an agent-loop continuation.
      enqueuePromises = nextEntries.map((entry) => Promise.resolve(enqueue(entry)));
      const steering = [...session.getSteeringMessages()];
      const followUp = [...session.getFollowUpMessages()];
      if (
        steering.length !== steeringEntries.length ||
        followUp.length !== followUpEntries.length
      ) {
        throw new Error("The SDK queue changed while it was being rebuilt");
      }
      setQueueProjection(steering, followUp, queueIds(steeringEntries), queueIds(followUpEntries));
    } catch (error) {
      // A partial public rebuild has no stable provenance. Do not let a later
      // queue shrink decorate the wrong transcript event or invite a retry.
      resetQueueIdentity();
      return queueManagementResult(operation, {
        ...(targetIntentId ? { targetIntentId } : {}),
        ...(targetQueue ? { queue: targetQueue } : {}),
        uncertain: true,
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      queueMutationActive = false;
    }

    try {
      await Promise.all(enqueuePromises);
    } catch (error) {
      // The public methods already changed Pi's queue synchronously, but an
      // asynchronous rejection means their final semantics are unknown. Keep
      // the actual queue visible and fence future item-level mutations.
      resetQueueIdentity();
      return queueManagementResult(operation, {
        ...(targetIntentId ? { targetIntentId } : {}),
        ...(targetQueue ? { queue: targetQueue } : {}),
        uncertain: true,
        message: error instanceof Error ? error.message : String(error),
      });
    }

    if (operation === "remove" && targetIntentId) {
      queuedPayloads.delete(targetIntentId);
      attachmentLedger.delete(targetIntentId);
    } else if (operation === "update" && targetIntentId) {
      const entry = nextEntries.find((candidate) => candidate.intentId === targetIntentId);
      if (entry && ownsQueuedIntent(targetIntentId)) {
        queuedPayloads.set(targetIntentId, structuredClone(entry.payload));
      }
    } else if (operation === "clear") {
      forgetQueuedPayloads(allCurrentIntentIds);
      for (const intentId of allCurrentIntentIds) attachmentLedger.delete(intentId);
    }

    return queueManagementResult(operation, {
      applied: true,
      ...(targetIntentId ? { targetIntentId } : {}),
      ...(targetQueue ? { queue: targetQueue } : {}),
    });
  }

  function attachmentsForClearedQueue() {
    // Pi exposes transformed queue text but not transformed images. Preserve
    // every original queued attachment separately and require user review;
    // never guess which transformed text entry it belongs to.
    const originals = [...attachmentLedger.values()]
      .sort((a, b) => a.ingressSequence - b.ingressSequence)
      .filter((entry) => entry.images.length > 0)
      .map((entry) => ({ intentId: entry.intentId, images: structuredClone(entry.images) }));
    attachmentLedger.clear();
    return originals;
  }

  async function requestEscape(requestId) {
    const base = { requestId, hostInstanceId, sessionEpoch };
    let value;
    try {
      if (navigationDepth > 0) {
        session.abortBranchSummary();
        value = { ...base, disposition: "abort_requested", target: "navigation" };
      } else if (compactionBarrierOpen()) {
        session.abortCompaction();
        if (["active", "active_unknown_origin", "retry_wait"].includes(compaction.phase)) {
          compaction = { ...compaction, phase: "cancelling" };
          observedOperation("compaction", "cancelling", {
            operationId: compaction.operationId,
          });
        }
        actualCompaction = true;
        value = { ...base, disposition: "abort_requested", target: "compaction" };
      } else if (session.isRetrying) {
        session.abortRetry();
        value = { ...base, disposition: "abort_requested", target: "retry" };
      } else if (session.isStreaming) {
        // Give a preflight-accepted delayed getter one final direct observation
        // before destructive clearQueue custody is recorded.
        readQueues();
        // Capture ownership before clearQueue(): real Pi can synchronously emit
        // queue_update while clearing, and that direct empty-queue observation
        // correctly retires positional identities for future delivery but must
        // not erase the restoration record's just-cleared GUI intents.
        const clearedIntentIds = [...queueIdentity.steer, ...queueIdentity.followUp].filter(
          (intentId) => typeof intentId === "string",
        );
        const queued = session.clearQueue() ?? {};
        // Destructive removal is not delivery. Retire positional identities
        // before the next snapshot observes the empty queues, otherwise those
        // intents could decorate an unrelated future user event.
        resetQueueIdentity();
        const steering = Array.isArray(queued.steering) ? queued.steering : [];
        const followUp = Array.isArray(queued.followUp) ? queued.followUp : [];
        const originalAttachments = attachmentsForClearedQueue();
        const hasRestoration =
          steering.length > 0 ||
          followUp.length > 0 ||
          originalAttachments.length > 0 ||
          clearedIntentIds.length > 0;
        const restorationId = hasRestoration ? crypto.randomUUID() : undefined;
        if (restorationId) {
          const restoration = {
            type: "queue_restoration",
            restorationId,
            steering,
            followUp,
            originalAttachments,
            clearedIntentIds,
            certainty: "not_processed",
          };
          restorations.set(restorationId, restoration);
          record(restoration);
        }
        void session.abort().catch(() => {});
        value = {
          ...base,
          disposition: "abort_requested",
          target: "streaming",
          ...(restorationId ? { restorationId } : {}),
        };
      } else if (session.isBashRunning) {
        session.abortBash();
        value = { ...base, disposition: "abort_requested", target: "bash" };
      } else if (submitting > 0 || unresolvedAdmissions > 0) {
        value = {
          ...base,
          disposition: "outcome_unknown",
          target: "editor",
          message: "Submission preflight cannot be cancelled; its outcome remains recoverable",
        };
      } else {
        value = {
          ...base,
          disposition: session.isIdle ? "already_inactive" : "not_applicable",
          target: "editor",
        };
      }
    } catch (err) {
      value = {
        ...base,
        disposition: "failed",
        message: err instanceof Error ? err.message : String(err),
      };
    } finally {
      if (value) record({ type: "escape", result: value });
      publishSnapshot();
    }
    return value;
  }

  // A command invocation is admission evidence, not proof that Pi emitted a
  // start. It still fences submissions until its promise settles or public
  // lifecycle evidence takes over.
  function beginCompactionInvocation(intentId = crypto.randomUUID()) {
    compaction = { ...compaction, invocationPending: true };
    activeIntents.set(intentId, "invoking");
    // This is command invocation evidence and a conservative admission
    // barrier, never fabricated proof that Pi observed compaction as active.
    observedOperation("command", "invoking", {
      operationId: intentId,
      intentId,
      command: "compact",
    });
    publishSnapshot();
    return intentId;
  }

  function settleCompactionInvocation(intentId, result = {}) {
    activeIntents.delete(intentId);
    compaction = { ...compaction, invocationPending: false };
    observedOperation(
      "command",
      result.failed === true ? "failed" : result.aborted === true ? "aborted" : "completed",
      { operationId: intentId, intentId, ...(result.detail ? { detail: result.detail } : {}) },
    );
    // Do not synthesize compaction start/end from a command promise. If Pi
    // supplied no observation, only the command invocation is journaled. A
    // real terminal event plus the settled getter does, however, release or
    // restore custody here because the event deliberately retained this
    // invocation barrier until the public compact() promise completed.
    reconcileCompactionGetter();
    if (!compactionBarrierOpen()) {
      const failed =
        result.failed === true ||
        result.aborted === true ||
        ["terminal_aborted", "terminal_failed"].includes(compaction.phase);
      if (failed) {
        restoreCustody(
          custody.filter((item) => item.phase === "compaction"),
          "Compaction ended without success; review this submission before retrying",
        );
      } else {
        scheduleCustodyDrain();
      }
    }
    publishSnapshot();
    return result;
  }

  function beginObservedOperation(kind, intentId, state = "started") {
    return observedOperation(kind, state, { intentId });
  }

  function settleObservedOperation(kind, operationId, result = {}) {
    return observedOperation(
      kind,
      result.unknown === true
        ? "unknown"
        : result.failed === true
          ? "failed"
          : result.cancelled === true || result.aborted === true
            ? "aborted"
            : "completed",
      {
        operationId,
        ...(result.intentId ? { intentId: result.intentId } : {}),
        ...(result.detail ? { detail: result.detail } : {}),
      },
    );
  }

  function failureEscrow() {
    const unknownObservedOperations = [
      ...observedJournal(),
      ...[...activeObservedOperations.values()].map((entry) =>
        operationProjection(entry, "unknown"),
      ),
    ];
    return {
      activeIntents: [...activeIntents].map(([intentId, disposition]) => ({
        intentId,
        disposition: "outcome_unknown",
      })),
      // A child can have accepted a wire intent but lose its process before a
      // terminal semantic frame is delivered. Preserve that exact owner-bound
      // admission as review-only unknown work; it is never replayed here or by
      // a successor authority.
      dispatchedIntents: [...dispatchedIntents.values()]
        .filter((entry) => !entry.outcome)
        .map((entry) => ({
          intentId: entry.intentId,
          owner: structuredClone(entry.owner),
          kind: entry.kind,
          state: "outcome_unknown",
        })),
      compaction: compactionBarrierOpen()
        ? { state: "outcome_unknown", lastObserved: compactionProjection() }
        : null,
      // No synthetic terminal is emitted on child loss. Active observations
      // are explicitly unknown, alongside the bounded recent history.
      recentObservedOperations: unknownObservedOperations,
      operationJournal: operationJournal
        .filter((entry) => entry.observed === true)
        .map((entry) => ({
          type: "observed_operation",
          sequence: entry.operationSequence,
          record: operationProjection(entry),
        })),
      operationJournalLowWatermark: journalBounds().low,
      operationJournalHighWatermark: journalBounds().high,
      operationJournalTruncated: operationJournalTruncated,
    };
  }

  function beginTransition(provisionalEpoch = sessionEpoch + 1, announce = true) {
    if (transition) throw new Error("A session transition is already active");
    let resolveSettled;
    const settled = new Promise((resolve) => {
      resolveSettled = resolve;
    });
    // Preserve a schema-shaped predecessor baseline before the SDK can
    // invalidate it. A replacement initiator is owner-bound to this snapshot;
    // its terminal outcome must be published on the old authority, never
    // smuggled into the successor frame.
    const priorSemanticSnapshot = semanticSnapshot();
    transition = {
      transitionId: crypto.randomUUID(),
      provisionalEpoch,
      priorSession: session,
      priorEpoch: sessionEpoch,
      priorSemanticSnapshot,
      boundaryCrossed: false,
      records: [],
      lastSnapshot: null,
      settled,
      resolveSettled,
    };
    if (announce) {
      sendControl({
        type: "transition_started",
        transitionId: transition.transitionId,
        provisionalEpoch,
      });
    }
    return transition.transitionId;
  }

  function adoptSession(
    nextSession,
    provisionalEpoch = transition?.provisionalEpoch ?? sessionEpoch + 1,
  ) {
    session = nextSession;
    sessionEpoch = provisionalEpoch;
    // Operation-journal coverage is owner-scoped. A successor baseline must
    // never advertise retained predecessor entries or predecessor watermarks.
    operationJournal.length = 0;
    nextOperationSequence = 0;
    operationJournalTruncated = false;
    actualCompaction = false;
    compactionGetterReconcilePending = false;
    compactionGetterReconcileToken++;
    compaction = {
      phase: "inactive",
      operationId: null,
      origin: null,
      attempt: 0,
      anomaly: null,
    };
    navigationDepth = 0;
    directDeliveryIntentId = null;
    activeObservedOperations.clear();
    resetQueueIdentity();
  }

  function takeTransitionBatch() {
    if (!transition) return null;
    const current = transition;
    const terminalSnapshot = snapshot();
    transition = null;
    current.resolveSettled();
    return {
      transitionId: current.transitionId,
      provisionalEpoch: current.provisionalEpoch,
      records: current.records.filter((recordValue) => !recordValue.provisionalPublished),
      terminalSnapshot,
    };
  }

  function commitTransition() {
    const batch = takeTransitionBatch();
    if (!batch) return publishSnapshot(true);
    sendControl({ type: "transition_batch", batch });
    // The compatibility batch installs the lock-held successor baseline in
    // main. Immediately follow it with exactly one successor-owned semantic
    // baseline so an already-attached renderer moves back to `following`
    // without an attach/repaint round trip.
    if (typeof sendFrame === "function") commitSemanticFrame([]);
    return batch.terminalSnapshot;
  }

  function commitInitialBinding() {
    const batch = takeTransitionBatch();
    if (batch) return batch;
    const terminalSnapshot = snapshot();
    return {
      transitionId: crypto.randomUUID(),
      provisionalEpoch: sessionEpoch,
      records: [],
      terminalSnapshot,
    };
  }

  function markTransitionBoundaryCrossed() {
    if (transition) transition.boundaryCrossed = true;
  }

  function hasTransitionBoundaryCrossed() {
    return transition?.boundaryCrossed === true;
  }

  async function requestFullSnapshot() {
    while (transition) await transition.settled;
    // state_request is a compatibility RPC whose response is always the
    // direct AgentSessionSnapshot. Frame consumers receive an independent
    // publication; never leak the frame envelope into this response.
    const value = snapshot();
    observeSnapshotMutation(value);
    if (typeof sendFrame === "function") {
      commitSemanticFrame([], true);
    } else {
      sendControl({ type: "snapshot", snapshot: value, full: true });
    }
    return value;
  }

  // Lifecycle admission is deliberately evaluated in this child, on the same
  // scheduler as Pi mutation ingress. Main receives no semantic facts: just an
  // opaque allow/deny verdict it can combine with transport identity.
  function lifecyclePermit(kind) {
    if (stopped || closePreparation?.confirmed) return { allowed: false, reason: "closing" };
    if (transition) return { allowed: false, reason: "transitioning" };
    const catalog = getCatalog() ?? {};
    const editor = getEditor() ?? {};
    const { steering, followUp } = readQueues();
    const sdkBusy =
      session.isIdle !== true ||
      session.isStreaming === true ||
      session.isCompacting === true ||
      session.isRetrying === true ||
      session.isBashRunning === true ||
      Number(session.pendingMessageCount ?? 0) > 0;
    const childWork =
      submitting > 0 ||
      unresolvedAdmissions > 0 ||
      activeIntents.size > 0 ||
      custody.length > 0 ||
      promptFence !== null ||
      navigationDepth > 0 ||
      compactionBarrierOpen();
    const pendingOtherIntent = [...dispatchedIntents.values()].some(
      (entry) => !entry.outcome && entry.kind !== kind,
    );
    const editorOrUi =
      editor.text !== "" ||
      (editor.attachments?.length ?? 0) > 0 ||
      editor.conflictText !== undefined ||
      editor.alternateConflictText !== undefined ||
      (editor.additionalConflictCandidates?.length ?? 0) > 0 ||
      Number(catalog.pendingDialogs ?? 0) > 0 ||
      (catalog.notifications?.length ?? 0) > 0 ||
      Object.keys(catalog.statuses ?? {}).length > 0 ||
      Object.keys(catalog.widgets ?? {}).length > 0 ||
      catalog.workingVisible === true ||
      catalog.workingMessage !== undefined;
    if (sdkBusy || childWork || pendingOtherIntent || steering.length > 0 || followUp.length > 0) {
      return { allowed: false, reason: "active" };
    }
    // Worktree respawn/reload preserve revisioned editor state during their
    // controlled transition. An unused activation visit is the only lifecycle
    // that must prove presentation emptiness before terminating its host.
    if (kind === "activation_visit_release" && editorOrUi) {
      return { allowed: false, reason: "presentation_active" };
    }
    return { allowed: true, reason: "allowed" };
  }

  function requestLifecyclePermit(kind) {
    return schedule("ingress", () => lifecyclePermit(kind));
  }

  // Atomically repeat lifecycle admission immediately before a child begins a
  // transition. A main permit is advisory transport authorization; this closes
  // the race between its response and the eventual reload message.
  function beginLifecycleTransition(
    kind,
    provisionalEpoch = sessionEpoch + 1,
    alreadySerialized = false,
  ) {
    const admit = () => {
      const verdict = lifecyclePermit(kind);
      if (verdict.allowed) beginTransition(provisionalEpoch);
      return verdict;
    };
    return alreadySerialized ? Promise.resolve(admit()) : schedule("ingress", admit);
  }

  // Baseline serialization is a synchronous read barrier over child-owned
  // state. Do not enqueue it behind mutation ingress: an admitted prompt or a
  // long-running command may legitimately keep that scheduler occupied while
  // the renderer still needs a baseline to display its events. JavaScript's
  // run-to-completion boundary gives the snapshot one coherent point; later
  // mutations advance source cursors and are replayed by main. Presentation
  // planes deliberately use independent cursors; panels remain synchronizing
  // until a forced repaint is acknowledged.
  function requestAuthorityAttach(rendererGeneration, presentation = {}) {
    // Attach must never sit behind a lifecycle transition: main/renderer can
    // retry from the successor publication once it commits.
    if (transition)
      return Promise.resolve({ status: "transitioning", transitionId: transition.transitionId });
    return Promise.resolve().then(() => {
      if (transition) return { status: "transitioning", transitionId: transition.transitionId };
      const semantic = semanticSnapshot();
      const owner = semantic.owner;
      // Cursor zero is not wire-valid. Reserve the initial semantic source
      // cursor for this baseline so the first later frame is contiguous (2),
      // rather than being mistaken for a duplicate of an attach at cursor 1.
      if (semanticTransportSequence === 0) semanticTransportSequence = 1;
      const cursor = {
        ...owner,
        transportSequence: semanticTransportSequence,
        snapshotSequence: semantic.snapshotSequence,
      };
      const transcriptCursor = {
        ...owner,
        transportSequence: presentationTransportSequence.transcript,
        snapshotSequence: semantic.snapshotSequence,
      };
      const extensionUiCursor = {
        ...owner,
        transportSequence: presentationTransportSequence.extensionUi,
        snapshotSequence: semantic.snapshotSequence,
      };
      const catalog = semantic.catalog;
      const journal = journalRecords(owner);
      // Every attached panel names the same panel-plane high-water cursor.
      // The source stream is shared across panel IDs, so a synchronizing
      // baseline still needs this cursor to continue with the next repaint.
      const panelHighWaterCursor = {
        ...owner,
        transportSequence: presentationTransportSequence.panel,
        snapshotSequence: Math.max(1, snapshotSequence),
      };
      const panels = (presentation.panels?.() ?? []).map((panel) => {
        const retained = panel.keyframe;
        const renderRevision = retained?.revision ?? panel.baseline?.revision ?? 0;
        return {
          panelKey: `panel:${panel.panelId}`,
          panelId: panel.panelId,
          owner,
          // A retained forced-repaint capture can be sent to an attaching
          // renderer, but remains fenced until that renderer acknowledges it.
          sync: {
            state: "synchronizing",
            lastCursor: panelHighWaterCursor,
            reason: retained ? "repaint_ack_pending" : "repaint_required",
          },
          overlay: panel.overlay === true,
          unified: panel.unified === true,
          mode: panel.mode ?? (panel.unified === true ? "content" : "viewport"),
          inputAcknowledgedThrough: panel.inputAcknowledgedThrough ?? 0,
          keyframe: retained
            ? { kind: "keyframe", ansi: retained.ansi, renderRevision }
            : { kind: "repaint_required", renderRevision },
        };
      });
      return {
        status: "ready",
        baseline: {
          // Main replaces this local identity with its SessionId while installing
          // the baseline. It is still a non-empty child correlation value.
          sessionId: String(session.sessionId ?? "session"),
          rendererGeneration,
          owner,
          semantic: { sync: { state: "following", cursor }, snapshot: semantic },
          operationJournal: journal,
          // A restoration is retained until the renderer explicitly acknowledges
          // it. Attach therefore carries the durable child-owned custody, even
          // when its original frame was emitted while no renderer was attached.
          restorations: [...restorations.values()].map((item) => structuredClone(item)),
          transcript: {
            sync: { state: "following", cursor: transcriptCursor },
            persistedHistoryCursor: transcriptPresentation.persistedHistoryCursor,
            liveTailCursor: transcriptPresentation.liveTailCursor,
            overlapBoundary: transcriptPresentation.overlapBoundary,
            ...(transcriptPresentation.currentStreamingMessage !== undefined
              ? {
                  currentStreamingMessage: structuredClone(
                    transcriptPresentation.currentStreamingMessage,
                  ),
                }
              : {}),
          },
          extensionUi: {
            sync: { state: "following", cursor: extensionUiCursor },
            notifications: catalog.notifications ?? [],
            statuses: catalog.statuses ?? {},
            widgets: catalog.widgets ?? {},
            dialogs: presentation.dialogs?.(rendererGeneration) ?? [],
          },
          panels,
          // The main router owns renderer-publication numbering. Zero means no
          // main publication is claimed by the child baseline itself.
          publicationHighWatermark: 0,
        },
      };
    });
  }

  function cancelTransition(_oldSession) {
    if (!transition) return publishSnapshot(true);
    // Cancellation must restore BOTH parts of runtime identity. In particular,
    // reload adopts the provisional epoch before its session-start boundary.
    const cancelled = transition;
    session = cancelled.priorSession;
    sessionEpoch = cancelled.priorEpoch;
    resetQueueIdentity();
    transition = null;
    const value = publishSnapshot(true);
    sendControl({ type: "transition_cancelled", transitionId: cancelled.transitionId });
    cancelled.resolveSettled();
    return value;
  }

  // This is a private forced-shutdown handshake, not a review checkpoint.
  // Its opaque token only fences the child between main's forced prepare and
  // confirmation; no renderer-visible state is captured or dumped.
  function prepareClose(force = false) {
    if (force) {
      for (const [intentId, disposition] of activeIntents) {
        if (["custody", "admitting", "consumed"].includes(disposition)) {
          activeIntents.set(intentId, "unknown");
        }
      }
    }
    const token = crypto.randomUUID();
    closePreparation = { token };
    return { token };
  }

  function confirmClose(token) {
    // Main has already installed its ingress fence. A forced close must not
    // be invalidated by a late child mutation while it is being torn down.
    const valid = closePreparation?.token === token;
    if (valid) {
      closePreparation.confirmed = true;
      stopped = true;
    }
    return { valid };
  }

  const poll = () => {
    if (stopped) return;
    publishSnapshot();
    setTimeout(poll, session.isIdle ? 2_000 : 250).unref?.();
  };
  setTimeout(poll, 250).unref?.();

  return {
    get hostInstanceId() {
      return hostInstanceId;
    },
    get sessionEpoch() {
      return sessionEpoch;
    },
    // Main follows the predecessor until the terminal transition batch is
    // published. SDK replacement may already have adopted the provisional
    // epoch, but live race responses (notably authorityAttach=transitioning)
    // must retain the currently published transport owner until that commit.
    get transportSessionEpoch() {
      return transition?.priorEpoch ?? sessionEpoch;
    },
    get currentSession() {
      return session;
    },
    get isTransitioning() {
      return transition !== null;
    },
    get transitionId() {
      return transition?.transitionId;
    },
    get hasActiveWork() {
      return (
        submitting > 0 ||
        unresolvedAdmissions > 0 ||
        activeIntents.size > 0 ||
        custody.length > 0 ||
        promptFence !== null
      );
    },
    canReplaceFromIntent(intentId) {
      if (!activeIntents.has(intentId)) return false;
      const hasOtherIntent = [...activeIntents.keys()].some((activeId) => activeId !== intentId);
      return (
        !hasOtherIntent &&
        custody.length === 0 &&
        submitting <= 1 &&
        unresolvedAdmissions === 0 &&
        !compactionBarrierOpen() &&
        navigationDepth === 0 &&
        !session.isCompacting &&
        !session.isRetrying &&
        !session.isBashRunning &&
        Number(session.pendingMessageCount ?? 0) === 0
      );
    },
    snapshot,
    publishSnapshot,
    // Opaque semantic-frame seam. Existing callers may continue consuming
    // snapshots/records until the host wire protocol adopts `sendFrame`.
    createSemanticFrame,
    commitSemanticFrame,
    requestFullSnapshot,
    requestLifecyclePermit,
    beginLifecycleTransition,
    requestAuthorityAttach,
    semanticSnapshot,
    observeEvent,
    publishExtensionUi,
    publishPanel,
    submit,
    manageQueue,
    dispatchIntent,
    beginCompactionInvocation,
    settleCompactionInvocation,
    settleTransitionInitiator,
    beginObservedOperation,
    settleObservedOperation,
    failureEscrow,
    requestEscape,
    runNavigation,
    beginTransition,
    adoptSession,
    commitTransition,
    commitInitialBinding,
    cancelTransition,
    markTransitionBoundaryCrossed,
    get transitionBoundaryCrossed() {
      return hasTransitionBoundaryCrossed();
    },
    captureOutbound,
    noteMutation,
    prepareClose,
    confirmClose,
    get isClosing() {
      return closePreparation !== null;
    },
    acknowledgeRestoration(id) {
      if (restorations.delete(id)) noteMutation();
    },
    stop() {
      stopped = true;
    },
  };
}
