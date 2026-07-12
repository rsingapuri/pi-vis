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
  let stopped = false;
  let actualCompaction = false;
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

  function snapshot() {
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
      },
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
    else sendRecord(recordValue);
  }

  function reportSubmission(result) {
    const submissionRecord = { type: "submission", result };
    // A forced predecessor settlement must never be folded into a successor's
    // atomic transition batch. Publish it on the live transition channel so
    // main can convert the old-epoch intent to review without invalidating the
    // successor batch identity.
    if (transition && result.sessionEpoch !== transition.provisionalEpoch) {
      noteMutation();
      sendRecord(submissionRecord);
    } else {
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
    const mutates =
      message?.type === "event" ||
      message?.type === "extension_ui_request" ||
      message?.type === "unified_submit_request" ||
      message?.type === "submission_disposition" ||
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

    if ((actualCompaction || navigationDepth > 0) && !fromCustody) {
      const custodyId = crypto.randomUUID();
      custody.push({
        custodyId,
        request: structuredClone(request),
        ingressSequence: ++ingressSequence,
        barrierId: `barrier-${barrierSequence}`,
        phase: actualCompaction ? "compaction" : "navigation",
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

  function submit(request) {
    // Defense in depth: renderer classification already omits images for slash
    // commands, but the host must never forward an attachment payload if a
    // stale or malformed caller supplies one.
    const normalized = request.text.startsWith("/") ? { ...request, images: [] } : request;
    return schedule("ingress", () => admit(normalized));
  }

  async function drainCustody() {
    if (actualCompaction || navigationDepth > 0 || custody.length === 0) return;
    custody.sort((a, b) => a.ingressSequence - b.ingressSequence);
    while (custody.length > 0 && !actualCompaction && navigationDepth === 0) {
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
    if (actualCompaction || navigationDepth > 0 || custody.length === 0) return;
    void schedule("custody", drainCustody);
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
      actualCompaction = true;
      barrierSequence++;
    } else if (event?.type === "compaction_end") {
      const failed = event.aborted === true || typeof event.errorMessage === "string";
      if (event.willRetry === true) {
        // Keep the barrier closed between retry attempts so new ingress joins
        // custody rather than overtaking the retained prefix.
        actualCompaction = true;
      } else {
        actualCompaction = false;
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
    record({ type: "event", event: publishedEvent });
    publishSnapshot();
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
      } else if (actualCompaction) {
        session.abortCompaction();
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
        !actualCompaction &&
        navigationDepth === 0 &&
        !session.isCompacting &&
        !session.isRetrying &&
        !session.isBashRunning &&
        Number(session.pendingMessageCount ?? 0) === 0
      );
    },
    snapshot,
    publishSnapshot,
    requestFullSnapshot,
    observeEvent,
    submit,
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
