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
  getCatalog = () => ({}),
  getEditor = () => ({ revision: 0, text: "", attachments: [] }),
  acceptEditorSubmission = () => false,
  getCheckpoint = () => ({}),
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
  let nextOperationSequence = 0;
  let operationJournalTruncated = false;
  const operationJournal = [];
  const recentIntentOutcomes = [];
  const intentLedger = new Map();
  // Target-protocol intents are independent from the compatibility submission
  // ledger above. Their key is explicitly owner-bound, so an old owner's
  // duplicate can never be admitted by a successor.
  const dispatchedIntents = new Map();
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
  // Positional identities parallel Pi's public transformed-text queues. Text is
  // presentation only: GUI ownership survives extension rewrites by following
  // FIFO queue slots and decorating the corresponding delivery event.
  let queueIdentity = { steer: [], followUp: [] };
  let queueLengths = { steer: 0, followUp: 0 };
  let queueValues = { steer: [], followUp: [] };

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
        if (!retainedSuffixUnchanged) identities.fill(null);
      } else if (queue.length > priorLength) {
        const priorPrefixUnchanged = priorValues.every((value, index) => value === queue[index]);
        if (!priorPrefixUnchanged) identities.fill(null);
        identities.push(...Array(queue.length - priorLength).fill(null));
      } else if (queue.some((value, index) => value !== priorValues[index])) {
        // Equal-length replacement has no public provenance. Invalidate all
        // mappings rather than letting a replacement inherit a GUI identity.
        identities.fill(null);
      }
      queueLengths[mode] = queue.length;
      queueValues[mode] = [...queue];
    }
    return deliveredQueueIntentIds;
  }

  function readQueues(deliveryExpected = false) {
    const steering = [...session.getSteeringMessages()];
    const followUp = [...session.getFollowUpMessages()];
    const deliveredQueueIntentIds = reconcileQueueIdentity(steering, followUp, deliveryExpected);
    return { steering, followUp, deliveredQueueIntentIds };
  }

  function registerQueuedIntent(request, priorLength) {
    const { steering, followUp } = readQueues();
    const mode = request.requestedMode === "steer" ? "steer" : "followUp";
    const queue = mode === "steer" ? steering : followUp;
    const identities = queueIdentity[mode];
    if (identities.includes(request.intentId)) return;
    // Successful admission may claim only the single slot appended relative
    // to its pre-prompt baseline. Extra/replaced slots are extension-owned or
    // ambiguous and must never inherit this GUI intent.
    if (queue.length !== priorLength + 1 || identities[priorLength] !== null) return;
    identities[priorLength] = request.intentId;
  }

  function resetQueueIdentity() {
    queueIdentity = { steer: [], followUp: [] };
    queueLengths = { steer: 0, followUp: 0 };
    queueValues = { steer: [], followUp: [] };
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

  function compactionBarrierOpen() {
    return (
      session.isCompacting === true ||
      ["active", "active_unknown_origin", "cancelling", "retry_wait"].includes(compaction.phase) ||
      compaction.invocationPending === true
    );
  }

  function setCompactionAnomaly(reason) {
    if (compaction.anomaly === reason) return;
    compaction = { ...compaction, anomaly: reason };
    appendOperation({
      kind: "compaction",
      phase: compaction.phase,
      operationId: compaction.operationId,
      anomaly: reason,
    });
  }

  function reconcileCompactionGetter() {
    const getterActive = session.isCompacting === true;
    if (
      getterActive &&
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
      appendOperation({
        kind: "compaction",
        phase: compaction.phase,
        operationId: compaction.operationId,
        origin: compaction.origin,
        attempt: compaction.attempt,
        anomaly: compaction.anomaly,
      });
    } else if (
      !getterActive &&
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
    if (!transition && typeof sendFrame === "function") return commitSemanticFrame([], full);
    const value = snapshot();
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
  function semanticSnapshot() {
    const value = snapshot();
    const owner = semanticOwner();
    const observed = operationJournal
      .filter((entry) => entry.kind === "compaction")
      .map((entry) => ({
        operationId: String(entry.operationId ?? entry.operationSequence),
        owner,
        kind: "compaction",
        state: ["active", "retry_wait"].includes(entry.phase)
          ? entry.phase === "retry_wait"
            ? "retry_wait"
            : "active"
          : entry.phase === "terminal_success"
            ? "completed"
            : entry.phase === "terminal_aborted"
              ? "aborted"
              : entry.phase === "terminal_failed"
                ? "failed"
                : "unknown",
        observedAt: entry.observedAt,
        ...(entry.anomaly ? { detail: String(entry.anomaly) } : {}),
      }));
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
    const compactionActivity = compactionBarrierOpen()
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
        ...(compactionActivity ? { compaction: compactionActivity } : {}),
      },
      queues: {
        steering: value.steering,
        followUp: value.followUp,
        steeringIntentIds: value.steeringIntentIds ?? value.steering.map(() => null),
        followUpIntentIds: value.followUpIntentIds ?? value.followUp.map(() => null),
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
        requiresReview: false,
      })),
      editor: value.editor,
      activeIntents: active,
      recentIntentOutcomes: outcomes,
      recentObservedOperations: observed,
      operationJournalLowWatermark: value.operationJournalLowWatermark,
      operationJournalHighWatermark: value.operationJournalHighWatermark,
      operationJournalTruncated: value.operationJournalTruncated,
      model: value.model,
      thinkingLevel: value.thinkingLevel,
      catalog: value.catalog,
    };
  }

  function authorityRecords(records) {
    const owner = semanticOwner();
    return records.flatMap((recordValue) => {
      // Pi events are transcript presentation records. Keeping them out of
      // semantic frames prevents a legacy/event path from implying liveness.
      if (recordValue?.type === "intent_outcome" && recordValue.outcome) {
        return [{ type: "intent_outcome", outcome: structuredClone(recordValue.outcome) }];
      }
      // Review custody is semantic evidence. Do not filter it out of the frame:
      // detached renderers recover these same retained entries from attach.
      if (recordValue?.type === "queue_restoration") return [structuredClone(recordValue)];
      return [];
    });
  }

  function createSemanticFrame(records = []) {
    const terminalSnapshot = semanticSnapshot();
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
      case "navigate":
        return {
          targetId: intent?.targetId ?? value.targetId ?? "unknown",
          ...(typeof value.summarized === "boolean" ? { summarized: value.summarized } : {}),
        };
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
      default:
        return undefined;
    }
  }

  function settleDispatchedIntent(intentId, owner, kind, state, result) {
    const key = intentOwnerKey(owner, intentId);
    const entry = dispatchedIntents.get(key);
    if (!entry || entry.outcome) return entry?.outcome;
    const normalizedResult = typedIntentResult(entry.intent, kind, result);
    const error =
      state === "failed" || state === "outcome_unknown"
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
    appendOperation({
      kind: "intent",
      phase: state,
      intentId,
      intentKind: kind,
      owner: structuredClone(owner),
    });
    // Outcomes are semantic records, never IPC-response completion claims.
    commitSemanticFrame([{ type: "intent_outcome", outcome }]);
    return outcome;
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
        requiresReview: true,
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
                if (wasStreaming) registerQueuedIntent(request, queueLengthBeforePrompt);
              }
              preflightResolve(success);
            },
          }),
        request.intentId,
      ),
    );
    if (!wasStreaming) promptFence = promptPromise;

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
        activeIntents.set(request.intentId, "unknown");
        if (wasStreaming) rememberAttachments(request);
        unresolvedAdmissions++;
        const stuckTimer = setTimeout(() => {
          if (activeIntents.get(request.intentId) === "unknown") {
            onAdmissionStuck({ intentId: request.intentId, sessionEpoch });
          }
        }, admissionStuckMs);
        stuckTimer.unref?.();
        void promptPromise
          .finally(() => {
            clearTimeout(stuckTimer);
            unresolvedAdmissions--;
          })
          .catch(() => {});
        // An unknown admission has a later terminal disposition when prompt
        // settles; do not leave consumers with a permanently non-terminal item.
        void promptPromise.then(
          () => {
            if (wasStreaming) registerQueuedIntent(request, queueLengthBeforePrompt);
            acknowledgeEditorCustody(request);
            activeIntents.delete(request.intentId);
            reportSubmission(resultFor(request, "completed", { queued: wasStreaming }));
            publishSnapshot();
          },
          (err) => {
            if (isExtension) acknowledgeEditorCustody(request);
            activeIntents.delete(request.intentId);
            reportSubmission(
              resultFor(request, isExtension ? "extension_error" : "outcome_unknown", {
                message: err instanceof Error ? err.message : String(err),
              }),
            );
            publishSnapshot();
          },
        );
        return resultFor(request, "outcome_unknown", {
          message: "Prompt admission did not acknowledge before its deadline",
        });
      }

      activeIntents.set(request.intentId, "consumed");
      acknowledgeEditorCustody(request);
      if (wasStreaming) {
        registerQueuedIntent(request, queueLengthBeforePrompt);
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
    if (
      !intent ||
      typeof intent.kind !== "string" ||
      typeof intentId !== "string" ||
      !owner ||
      typeof owner.hostInstanceId !== "string" ||
      !Number.isInteger(owner.sessionEpoch)
    ) {
      return Promise.resolve({
        status: "not_admitted",
        intentId: intentId ?? "",
        reason: "invalid",
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
    const fingerprint = stableFingerprint({ owner, intent });
    const prior = dispatchedIntents.get(key);
    if (prior) {
      if (prior.fingerprint !== fingerprint) {
        return Promise.resolve({ status: "not_admitted", intentId, reason: "invalid" });
      }
      return Promise.resolve({ status: "duplicate", intentId, owner: structuredClone(owner) });
    }

    // This write happens before scheduling any possible SDK call. The bounded
    // operation journal therefore has a durable admission boundary even if the
    // child dies during dispatch.
    const entry = {
      intentId,
      fingerprint,
      kind: intent.kind,
      intent: structuredClone(intent),
      owner: structuredClone(owner),
      recordedAt: Date.now(),
      outcome: null,
    };
    dispatchedIntents.set(key, entry);
    appendOperation({
      kind: "intent",
      phase: "admitted",
      intentId,
      intentKind: intent.kind,
      owner: structuredClone(owner),
    });
    commitSemanticFrame([{ type: "intent_admitted", intentId, owner, kind: intent.kind }]);

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
        const result = await execute(intent, owner);
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
        const state =
          result?.cancelled === true || result?.aborted === true ? "cancelled" : "completed";
        settleDispatchedIntent(intentId, owner, intent.kind, state, result);
      } catch (error) {
        settleDispatchedIntent(intentId, owner, intent.kind, "failed", {
          message: error instanceof Error ? error.message : String(error),
        });
      } finally {
        publishSnapshot();
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
    let publishedEvent = event;
    if (event?.type === "message_start" && event.message?.role === "user") {
      const { deliveredQueueIntentIds } = readQueues(true);
      // More than one removal for one event is ambiguous; retire all rather
      // than assigning an arbitrary GUI intent.
      const queueIntentId =
        deliveredQueueIntentIds.length === 1 ? deliveredQueueIntentIds[0] : undefined;
      if (queueIntentId) publishedEvent = { ...event, queueIntentId };
    }
    if (event?.type === "compaction_start") {
      const retrying = compaction.phase === "retry_wait";
      compaction = {
        phase: "active",
        operationId: retrying ? compaction.operationId : crypto.randomUUID(),
        origin: "event",
        attempt: retrying ? compaction.attempt + 1 : Math.max(1, compaction.attempt + 1),
        anomaly: null,
      };
      barrierSequence++;
      appendOperation({
        kind: "compaction",
        phase: "active",
        operationId: compaction.operationId,
        origin: "event",
        attempt: compaction.attempt,
      });
    } else if (event?.type === "compaction_end") {
      const failed = event.aborted === true || typeof event.errorMessage === "string";
      if (event.willRetry === true) {
        // Keep the barrier closed between retry attempts so new ingress joins
        // custody rather than overtaking the retained prefix.
        compaction = { ...compaction, phase: "retry_wait", anomaly: null };
        appendOperation({
          kind: "compaction",
          phase: "retry_wait",
          operationId: compaction.operationId,
          attempt: compaction.attempt,
        });
      } else {
        compaction = {
          ...compaction,
          phase: failed
            ? event.aborted === true
              ? "terminal_aborted"
              : "terminal_failed"
            : "terminal_success",
          anomaly: null,
          invocationPending: false,
        };
        appendOperation({
          kind: "compaction",
          phase: compaction.phase,
          operationId: compaction.operationId,
          attempt: compaction.attempt,
          ...(failed && typeof event.errorMessage === "string"
            ? { error: event.errorMessage }
            : {}),
        });
      }
      // Direct getter evidence is sampled before custody is released. A stale
      // false/true disagreement leaves the barrier closed and is visible in
      // the same semantic frame rather than being resolved by the renderer.
      reconcileCompactionGetter();
      if (!compactionBarrierOpen()) {
        if (failed) {
          restoreCustody(
            custody.filter((item) => item.phase === "compaction"),
            "Compaction ended without success; review this submission before retrying",
          );
        } else {
          scheduleCustodyDrain();
        }
      }
    }
    actualCompaction = compactionBarrierOpen();
    // The semantic commit retains only semantic facts. The original event is
    // published exactly once on the transcript plane with its own cursor.
    const frame = commitSemanticFrame([]);
    publishTranscript([publishedEvent]);
    return frame;
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
      requiresReview: true,
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
    publishSnapshot();
    let shouldDrain = true;
    try {
      const result = await fn();
      if (result?.cancelled === true || result?.aborted === true) {
        shouldDrain = false;
        restoreCancelledNavigationCustody(
          navigationBarrierId,
          "Navigation was cancelled; review this submission before retrying",
        );
      }
      return result;
    } catch (error) {
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
          appendOperation({
            kind: "compaction",
            phase: "cancelling",
            operationId: compaction.operationId,
            attempt: compaction.attempt,
          });
        }
        actualCompaction = true;
        value = { ...base, disposition: "abort_requested", target: "compaction" };
      } else if (session.isRetrying) {
        session.abortRetry();
        value = { ...base, disposition: "abort_requested", target: "retry" };
      } else if (session.isStreaming) {
        const queued = session.clearQueue() ?? {};
        const clearedIntentIds = [...queueIdentity.steer, ...queueIdentity.followUp].filter(
          (intentId) => typeof intentId === "string",
        );
        // Destructive removal is not delivery. Retire positional identities
        // before the next snapshot observes the empty queues, otherwise those
        // intents could decorate an unrelated future user event.
        resetQueueIdentity();
        const restorationId = crypto.randomUUID();
        const restoration = {
          type: "queue_restoration",
          restorationId,
          steering: Array.isArray(queued.steering) ? queued.steering : [],
          followUp: Array.isArray(queued.followUp) ? queued.followUp : [],
          originalAttachments: attachmentsForClearedQueue(),
          clearedIntentIds,
          requiresReview: true,
        };
        restorations.set(restorationId, restoration);
        record(restoration);
        void session.abort().catch(() => {});
        value = { ...base, disposition: "abort_requested", target: "streaming", restorationId };
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
    publishSnapshot();
    return intentId;
  }

  function settleCompactionInvocation(intentId, result = {}) {
    activeIntents.delete(intentId);
    compaction = { ...compaction, invocationPending: false };
    // Do not synthesize start/end from a command promise. If Pi supplied no
    // observation, the snapshot remains inactive; if it is open, the journal
    // remains the last public evidence.
    publishSnapshot();
    return result;
  }

  function failureEscrow() {
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
      operationJournal: structuredClone(operationJournal),
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
    transition = {
      transitionId: crypto.randomUUID(),
      provisionalEpoch,
      priorSession: session,
      priorEpoch: sessionEpoch,
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
    actualCompaction = false;
    compaction = {
      phase: "inactive",
      operationId: null,
      origin: null,
      attempt: 0,
      anomaly: null,
    };
    navigationDepth = 0;
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
    return publishSnapshot(true);
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

  // Runs through the same scheduler as mutation ingress. Thus an attach that
  // races a compaction end or replacement observes the terminal commit, never
  // an arbitrary interleaving. Presentation planes deliberately use independent
  // cursors; panels are synchronizing until a forced repaint is acknowledged.
  function requestAuthorityAttach(rendererGeneration, presentation = {}) {
    return schedule("ingress", async () => {
      while (transition) await transition.settled;
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
      const journal = operationJournal
        .filter((entry) => entry.kind === "compaction")
        .map((entry) => ({
          type: "observed_operation",
          sequence: entry.operationSequence,
          record: {
            operationId: String(entry.operationId ?? entry.operationSequence),
            owner,
            kind: "compaction",
            state: ["active", "retry_wait"].includes(entry.phase)
              ? entry.phase === "retry_wait"
                ? "retry_wait"
                : "active"
              : entry.phase === "terminal_success"
                ? "completed"
                : entry.phase === "terminal_aborted"
                  ? "aborted"
                  : entry.phase === "terminal_failed"
                    ? "failed"
                    : "unknown",
            observedAt: entry.observedAt,
            ...(entry.anomaly ? { detail: String(entry.anomaly) } : {}),
          },
        }));
      const panels = (presentation.panels?.() ?? []).map((panel) => ({
        panelKey: `panel:${panel.panelId}`,
        panelId: panel.panelId,
        owner,
        sync: { state: "synchronizing", reason: "repaint_required" },
        overlay: panel.overlay === true,
        unified: panel.unified === true,
        inputAcknowledgedThrough: panel.inputAcknowledgedThrough ?? 0,
        keyframe: {
          kind: "repaint_required",
          renderRevision: panel.baseline?.revision ?? 0,
        },
      }));
      return {
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

  function prepareClose(force = false) {
    const currentSnapshot = snapshot();
    observeSnapshotMutation(currentSnapshot);
    if (force) {
      for (const [intentId, disposition] of activeIntents) {
        if (["custody", "admitting", "consumed"].includes(disposition)) {
          activeIntents.set(intentId, "unknown");
        }
      }
    }
    const token = crypto.randomUUID();
    closePreparation = { token, mutationSequence };
    return {
      token,
      mutationSequence,
      snapshot: currentSnapshot,
      custody: custody.map((item) => structuredClone(item)),
      activeIntents: [...activeIntents].map(([intentId, disposition]) => ({
        intentId,
        disposition,
      })),
      restorations: [...restorations.values()].map((item) => structuredClone(item)),
      ui: structuredClone(getCheckpoint()),
    };
  }

  function confirmClose(token) {
    const currentSnapshot = snapshot();
    observeSnapshotMutation(currentSnapshot);
    const valid =
      closePreparation?.token === token && closePreparation.mutationSequence === mutationSequence;
    if (valid) {
      closePreparation.confirmed = true;
      // The caller is now entitled to dispose the process. Stop accepting any
      // further authoritative work in the gap before the parent terminates us.
      stopped = true;
    }
    return { valid, mutationSequence, snapshot: currentSnapshot };
  }

  function cancelClose(token) {
    if (closePreparation?.token !== token || closePreparation.confirmed) return false;
    closePreparation = null;
    return true;
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
    dispatchIntent,
    beginCompactionInvocation,
    settleCompactionInvocation,
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
    cancelClose,
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
