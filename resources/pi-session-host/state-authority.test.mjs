import { afterEach, describe, expect, it, vi } from "vitest";
import { createStateAuthority } from "./state-authority.mjs";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeSession(overrides = {}) {
  return {
    isStreaming: false,
    isIdle: true,
    isCompacting: false,
    isRetrying: false,
    retryAttempt: 0,
    isBashRunning: false,
    model: { provider: "anthropic", id: "claude" },
    thinkingLevel: "medium",
    sessionId: "session-1",
    sessionFile: "/tmp/session.jsonl",
    sessionName: "Session",
    pendingMessageCount: 0,
    getSteeringMessages: vi.fn(() => []),
    getFollowUpMessages: vi.fn(() => []),
    extensionRunner: { getCommand: vi.fn(() => undefined) },
    prompt: vi.fn((_text, options) => {
      options.preflightResult(true);
      return Promise.resolve();
    }),
    abort: vi.fn(async () => {}),
    abortBranchSummary: vi.fn(),
    abortCompaction: vi.fn(),
    abortRetry: vi.fn(),
    abortBash: vi.fn(),
    clearQueue: vi.fn(() => ({})),
    ...overrides,
  };
}

function makeRequest(intentId, overrides = {}) {
  return {
    intentId,
    expectedHostId: "host-1",
    expectedEpoch: 0,
    editorRevision: 1,
    text: intentId,
    requestedMode: "followUp",
    surface: "composer",
    images: [],
    ...overrides,
  };
}

function setup(sessionOverrides = {}, options = {}) {
  const session = makeSession(sessionOverrides);
  const sendControl = vi.fn();
  const sendRecord = vi.fn();
  let editor = { revision: 1, text: "draft" };
  const authority = createStateAuthority({
    hostInstanceId: "host-1",
    initialSession: session,
    sendControl,
    sendRecord,
    getCatalog: () => ({ pendingDialogs: 3 }),
    getEditor: () => editor,
    ...options,
  });
  return {
    session,
    authority,
    sendControl,
    sendRecord,
    setEditor(value) {
      editor = value;
    },
  };
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(() => {
  vi.useRealTimers();
});

describe("state authority", () => {
  it("copies direct SDK getters into snapshots and forwards raw events without inference", () => {
    const { authority, session, sendControl, sendRecord } = setup({
      isStreaming: false,
      isIdle: false,
      isCompacting: true,
      isRetrying: true,
      retryAttempt: 4,
      isBashRunning: true,
      getSteeringMessages: vi.fn(() => ["direct steer"]),
      getFollowUpMessages: vi.fn(() => ["direct follow-up"]),
    });

    authority.observeEvent({ type: "agent_start", willRetry: false });
    const snapshot = authority.snapshot();

    expect(sendRecord).toHaveBeenCalledWith({
      type: "event",
      event: { type: "agent_start", willRetry: false },
    });
    expect(snapshot).toMatchObject({
      isStreaming: session.isStreaming,
      isIdle: session.isIdle,
      isCompacting: session.isCompacting,
      isRetrying: session.isRetrying,
      retryAttempt: session.retryAttempt,
      isBashRunning: session.isBashRunning,
      steering: ["direct steer"],
      followUp: ["direct follow-up"],
    });
    expect(sendControl.mock.calls.at(-1)[0].snapshot.isStreaming).toBe(false);
  });

  it("never forwards slash-command images and acknowledges only its editor text", async () => {
    const acceptEditorSubmission = vi.fn(() => true);
    const { authority, session } = setup(
      {},
      {
        getEditor: () => ({
          revision: 1,
          text: "/widget-on",
          attachments: [{ kind: "file", path: "/tmp/notes.txt" }],
        }),
        acceptEditorSubmission,
      },
    );

    await expect(
      authority.submit(
        makeRequest("slash", {
          text: "/widget-on",
          images: [{ data: "image-bytes", mimeType: "image/png" }],
        }),
      ),
    ).resolves.toMatchObject({ disposition: "consumed" });

    expect(session.prompt).toHaveBeenCalledWith(
      "/widget-on",
      expect.not.objectContaining({ images: expect.anything() }),
    );
    expect(acceptEditorSubmission).toHaveBeenCalledWith(
      expect.objectContaining({ text: "/widget-on", images: [] }),
    );
  });

  it("treats leading-whitespace slash text as an ordinary prompt", async () => {
    const acceptEditorSubmission = vi.fn(() => true);
    const { authority, session } = setup({}, { acceptEditorSubmission });
    const images = [{ data: "image-bytes", mimeType: "image/png" }];

    await expect(
      authority.submit(makeRequest("ordinary", { text: "  /tmp/file is relevant", images })),
    ).resolves.toMatchObject({ disposition: "consumed" });

    expect(session.prompt).toHaveBeenCalledWith(
      "  /tmp/file is relevant",
      expect.objectContaining({ images }),
    );
    expect(acceptEditorSubmission).toHaveBeenCalledWith(
      expect.objectContaining({ text: "  /tmp/file is relevant", images }),
    );
  });

  it("returns explicit custody instead of holding IPC behind an unresolved idle prompt fence", async () => {
    const first = deferred();
    const second = deferred();
    let calls = 0;
    const { authority, session, sendRecord } = setup({
      prompt: vi.fn((_text, options) => {
        options.preflightResult(true);
        if (++calls === 1) {
          session.isStreaming = true;
          return first.promise;
        }
        session.isStreaming = true;
        return second.promise;
      }),
    });

    const one = authority.submit(makeRequest("one"));
    await expect(one).resolves.toMatchObject({ disposition: "consumed" });
    session.isStreaming = false;
    const two = authority.submit(makeRequest("two"));
    await expect(two).resolves.toMatchObject({ disposition: "in_custody" });
    expect(session.prompt).toHaveBeenCalledTimes(1);

    first.resolve();
    await vi.waitFor(() =>
      expect(session.prompt.mock.calls.map(([text]) => text)).toEqual(["one", "two"]),
    );
    expect(sendRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "submission",
        result: expect.objectContaining({ intentId: "two", disposition: "consumed" }),
      }),
    );
    second.resolve();
  });

  it("leaves a custody suffix queued without blocking later ingress on a drained prompt fence", async () => {
    vi.useFakeTimers();
    const firstDrain = deferred();
    let promptCalls = 0;
    const { authority, session } = setup({
      prompt: vi.fn((_text, options) => {
        options.preflightResult(true);
        promptCalls++;
        if (promptCalls === 1) return firstDrain.promise;
        session.isStreaming = true;
        return Promise.resolve();
      }),
    });
    authority.observeEvent({ type: "compaction_start" });
    await authority.submit(makeRequest("held-a"));
    await authority.submit(makeRequest("held-b"));
    authority.observeEvent({ type: "compaction_end" });
    await vi.advanceTimersByTimeAsync(2_000);
    await flush();
    expect(session.prompt.mock.calls.map(([text]) => text)).toEqual(["held-a"]);

    const later = authority.submit(makeRequest("held-c"));
    await expect(later).resolves.toMatchObject({ disposition: "in_custody" });
    expect(session.prompt).toHaveBeenCalledTimes(1);

    firstDrain.resolve();
    await vi.waitFor(() =>
      expect(session.prompt.mock.calls.map(([text]) => text)).toEqual([
        "held-a",
        "held-b",
        "held-c",
      ]),
    );
  });

  it("admits direct steering while Pi reports active streaming", async () => {
    const { authority, session } = setup({ isStreaming: true });
    const result = await authority.submit(makeRequest("steer-now", { requestedMode: "steer" }));

    expect(result.disposition).toBe("consumed");
    expect(session.prompt).toHaveBeenCalledWith(
      "steer-now",
      expect.objectContaining({ source: "interactive", streamingBehavior: "steer" }),
    );
  });

  it("registers queue identity synchronously before re-entrant delivery after preflight", async () => {
    const promptDone = deferred();
    let steering = [];
    const { authority, sendRecord } = setup({
      isStreaming: true,
      getSteeringMessages: vi.fn(() => steering),
      prompt: vi.fn((_text, options) => {
        steering = ["transformed queued"];
        options.preflightResult(true);
        steering = [];
        authority.observeEvent({
          type: "message_start",
          message: { role: "user", content: "transformed delivery" },
        });
        return promptDone.promise;
      }),
    });

    await authority.submit(
      makeRequest("intent-reentrant", { text: "original", requestedMode: "steer" }),
    );
    expect(sendRecord).toHaveBeenCalledWith({
      type: "event",
      event: {
        type: "message_start",
        message: { role: "user", content: "transformed delivery" },
        queueIntentId: "intent-reentrant",
      },
    });
    promptDone.resolve();
  });

  it("synchronizes external queue additions before capturing the admission baseline", async () => {
    const promptDone = deferred();
    let steering = [];
    const { authority } = setup({
      isStreaming: true,
      getSteeringMessages: vi.fn(() => steering),
      prompt: vi.fn((_text, options) => {
        steering.push("GUI transformed");
        options.preflightResult(true);
        return promptDone.promise;
      }),
    });
    steering = ["external before admission"];

    await authority.submit(
      makeRequest("intent-after-external", { text: "original", requestedMode: "steer" }),
    );
    expect(authority.snapshot().steeringIntentIds).toEqual([null, "intent-after-external"]);
    promptDone.resolve();
  });

  it("does not assign a GUI intent when preflight adds multiple ambiguous slots", async () => {
    const promptDone = deferred();
    let steering = [];
    const { authority, sendRecord } = setup({
      isStreaming: true,
      getSteeringMessages: vi.fn(() => steering),
      prompt: vi.fn((_text, options) => {
        steering = ["GUI transformed", "extension addition"];
        options.preflightResult(true);
        return promptDone.promise;
      }),
    });

    await authority.submit(
      makeRequest("intent-ambiguous-add", { text: "original", requestedMode: "steer" }),
    );
    expect(authority.snapshot().steeringIntentIds).toEqual([null, null]);
    steering = ["extension addition"];
    authority.observeEvent({
      type: "message_start",
      message: { role: "user", content: "GUI transformed delivery" },
    });
    expect(sendRecord).toHaveBeenLastCalledWith({
      type: "event",
      event: {
        type: "message_start",
        message: { role: "user", content: "GUI transformed delivery" },
      },
    });
    promptDone.resolve();
  });

  it("tracks transformed queue slots and decorates their transformed delivery by intent", async () => {
    const promptDone = deferred();
    let steering = [];
    const { authority, sendRecord } = setup({
      isStreaming: true,
      getSteeringMessages: vi.fn(() => steering),
      prompt: vi.fn((_text, options) => {
        steering = ["extension prefix original"];
        options.preflightResult(true);
        return promptDone.promise;
      }),
    });

    await expect(
      authority.submit(
        makeRequest("intent-transformed", { text: "original", requestedMode: "steer" }),
      ),
    ).resolves.toMatchObject({ disposition: "consumed", queued: true });
    expect(authority.snapshot()).toMatchObject({
      steering: ["extension prefix original"],
      steeringIntentIds: ["intent-transformed"],
    });

    steering = [];
    authority.observeEvent({
      type: "message_start",
      message: { role: "user", content: "fully rewritten delivery" },
    });
    expect(sendRecord).toHaveBeenCalledWith({
      type: "event",
      event: {
        type: "message_start",
        message: { role: "user", content: "fully rewritten delivery" },
        queueIntentId: "intent-transformed",
      },
    });
    promptDone.resolve();
  });

  it("does not consume idle input when streaming appears before delayed preflight rejection", async () => {
    vi.useFakeTimers();
    const promptDone = deferred();
    let reportPreflight;
    const { authority, session } = setup({
      prompt: vi.fn((_text, options) => {
        reportPreflight = options.preflightResult;
        session.isStreaming = true;
        return promptDone.promise;
      }),
    });

    let settled = false;
    const pending = authority.submit(makeRequest("delayed-reject")).finally(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(settled).toBe(false);

    reportPreflight(false);
    await expect(pending).resolves.toMatchObject({ disposition: "rejected" });
    promptDone.resolve();
  });

  it("reports uncertainty when prompt rejects after successful idle preflight", async () => {
    const acceptEditorSubmission = vi.fn();
    const { authority } = setup(
      {
        prompt: vi.fn((_text, options) => {
          options.preflightResult(true);
          return Promise.reject(new Error("failed after preflight"));
        }),
      },
      { acceptEditorSubmission },
    );

    await expect(authority.submit(makeRequest("post-preflight-failure"))).resolves.toMatchObject({
      disposition: "outcome_unknown",
      message: "failed after preflight",
    });
    expect(acceptEditorSubmission).not.toHaveBeenCalled();
  });

  it("aborts an existing turn before reporting unresolved submission preflight", async () => {
    const promptDone = deferred();
    let reportPreflight;
    const { authority, session } = setup({
      isStreaming: true,
      prompt: vi.fn((_text, options) => {
        reportPreflight = options.preflightResult;
        return promptDone.promise;
      }),
    });

    const pending = authority.submit(makeRequest("pending-steer"));
    await flush();
    await expect(authority.requestEscape("esc-preflight")).resolves.toMatchObject({
      disposition: "abort_requested",
      target: "streaming",
    });
    expect(session.abort).toHaveBeenCalledTimes(1);
    expect(session.clearQueue).toHaveBeenCalledTimes(1);

    reportPreflight(true);
    await expect(pending).resolves.toMatchObject({ disposition: "consumed" });
    promptDone.resolve();
  });

  it("drains compaction custody FIFO before a later normal submit and retains a failed suffix", async () => {
    const calls = [];
    const { authority, session, setEditor } = setup({
      prompt: vi.fn((text, options) => {
        calls.push(text);
        options.preflightResult(text !== "second");
        return Promise.resolve();
      }),
    });

    authority.observeEvent({ type: "compaction_start" });
    await expect(authority.submit(makeRequest("first"))).resolves.toMatchObject({
      disposition: "in_custody",
    });
    await authority.submit(makeRequest("second"));
    await authority.submit(makeRequest("third"));
    // Clearing after in_custody advances the synchronized revision; these
    // payloads are already owned and must not be rejected at dequeue.
    setEditor({ revision: 9, text: "new local draft" });

    authority.observeEvent({ type: "compaction_end" });
    const later = authority.submit(makeRequest("later", { editorRevision: 9 }));
    await later;

    expect(calls).toEqual(["first", "second", "later"]);
    expect(authority.snapshot().hostFacts.custodyCount).toBe(2);
  });

  it("never replays custody whose original admission became outcome-unknown", async () => {
    vi.useFakeTimers();
    const pending = deferred();
    const { authority, session, sendRecord } = setup({
      prompt: vi.fn((_text, options) => {
        options.preflightResult(true);
        return pending.promise;
      }),
    });
    authority.observeEvent({ type: "compaction_start" });
    await authority.submit(makeRequest("slow-custody", { text: "only once" }));
    authority.observeEvent({ type: "compaction_end" });
    await vi.advanceTimersByTimeAsync(2_000);
    await flush();

    expect(session.prompt).toHaveBeenCalledTimes(1);
    expect(sendRecord).toHaveBeenCalledWith(
      expect.objectContaining({ type: "queue_restoration", followUp: ["only once"] }),
    );
    pending.resolve();
    await flush();
    authority.observeEvent({ type: "compaction_start" });
    authority.observeEvent({ type: "compaction_end" });
    await flush();

    expect(session.prompt).toHaveBeenCalledTimes(1);
  });

  it("re-enters the captured surface when delayed custody actually executes", async () => {
    const runWithSurface = vi.fn((_surface, operation) => operation());
    const { authority } = setup({}, { runWithSurface });
    authority.observeEvent({ type: "compaction_start" });
    await authority.submit(makeRequest("composer-custody", { surface: "composer" }));
    expect(runWithSurface).not.toHaveBeenCalled();

    authority.observeEvent({ type: "compaction_end" });
    await vi.waitFor(() =>
      expect(runWithSurface).toHaveBeenCalledWith(
        "composer",
        expect.any(Function),
        "composer-custody",
      ),
    );
  });

  it("also drains navigation custody before later ingress", async () => {
    const holdNavigation = deferred();
    const { authority, session } = setup();
    const navigation = authority.runNavigation(() => holdNavigation.promise);
    await flush();
    await authority.submit(makeRequest("during-navigation"));

    holdNavigation.resolve();
    await navigation;
    const later = authority.submit(makeRequest("after-navigation"));
    await later;

    expect(session.prompt.mock.calls.map(([text]) => text)).toEqual([
      "during-navigation",
      "after-navigation",
    ]);
  });

  it("restores compaction custody after an aborted terminal event", async () => {
    const { authority, session, sendRecord } = setup();
    authority.observeEvent({ type: "compaction_start" });
    await authority.submit(makeRequest("aborted-compaction", { text: "keep me" }));

    authority.observeEvent({ type: "compaction_end", aborted: true });
    await flush();

    expect(session.prompt).not.toHaveBeenCalled();
    expect(sendRecord).toHaveBeenCalledWith(
      expect.objectContaining({ type: "queue_restoration", followUp: ["keep me"] }),
    );
    expect(authority.snapshot().hostFacts.custodyCount).toBe(0);
  });

  it("restores navigation custody for review instead of submitting after cancellation", async () => {
    const holdNavigation = deferred();
    const { authority, session, sendRecord } = setup();
    const navigation = authority.runNavigation(() => holdNavigation.promise);
    await flush();
    await authority.submit(
      makeRequest("cancelled-navigation", {
        text: "review me",
        images: [{ data: "image" }],
      }),
    );

    holdNavigation.resolve({ cancelled: true });
    await navigation;
    await flush();

    expect(session.prompt).not.toHaveBeenCalled();
    expect(sendRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "queue_restoration",
        followUp: ["review me"],
        originalAttachments: [{ intentId: "cancelled-navigation", images: [{ data: "image" }] }],
      }),
    );
    expect(authority.snapshot().hostFacts.custodyCount).toBe(0);
  });

  it("drains inner-navigation custody when the outer navigation cancels", async () => {
    const { authority, session, sendRecord } = setup();

    await authority.runNavigation(async () => {
      await authority.runNavigation(async () => {
        await expect(
          authority.submit(makeRequest("inner-navigation", { text: "submit after nesting" })),
        ).resolves.toMatchObject({ disposition: "in_custody" });
        return { cancelled: false };
      });
      return { cancelled: true };
    });

    await vi.waitFor(() => expect(session.prompt).toHaveBeenCalledTimes(1));
    expect(authority.snapshot().hostFacts.custodyCount).toBe(0);
    expect(sendRecord).not.toHaveBeenCalledWith(
      expect.objectContaining({
        type: "queue_restoration",
        followUp: ["submit after nesting"],
      }),
    );
  });

  it("restores navigation custody when navigation throws", async () => {
    const holdNavigation = deferred();
    const { authority, session, sendRecord } = setup();
    const navigation = authority.runNavigation(() => holdNavigation.promise);
    await flush();
    await authority.submit(makeRequest("failed-navigation", { text: "recover me" }));

    holdNavigation.reject(new Error("navigation failed"));
    await expect(navigation).rejects.toThrow("navigation failed");

    expect(session.prompt).not.toHaveBeenCalled();
    expect(sendRecord).toHaveBeenCalledWith(
      expect.objectContaining({ type: "queue_restoration", followUp: ["recover me"] }),
    );
  });

  it("retires a consumed extension failure from custody instead of executing it twice", async () => {
    const { authority, session, sendRecord } = setup({
      extensionRunner: { getCommand: vi.fn(() => ({ name: "side-effect" })) },
      prompt: vi.fn((_text, options) => {
        options.preflightResult(true);
        return Promise.reject(new Error("extension failed after invocation"));
      }),
    });
    authority.observeEvent({ type: "compaction_start" });
    await expect(
      authority.submit(makeRequest("extension-custody", { text: "/side-effect" })),
    ).resolves.toMatchObject({ disposition: "in_custody" });

    authority.observeEvent({ type: "compaction_end" });
    await vi.waitFor(() => expect(authority.snapshot().hostFacts.custodyCount).toBe(0));

    expect(session.prompt).toHaveBeenCalledTimes(1);
    expect(sendRecord).toHaveBeenCalledWith({
      type: "submission",
      result: expect.objectContaining({
        intentId: "extension-custody",
        disposition: "extension_error",
      }),
    });
    authority.observeEvent({ type: "compaction_start" });
    authority.observeEvent({ type: "compaction_end" });
    await flush();
    expect(session.prompt).toHaveBeenCalledTimes(1);
  });

  it("does not guess attachment identity when the front of a multi-item queue is consumed", async () => {
    let steering = ["A", "B"];
    const { authority, session, sendRecord } = setup({
      isStreaming: true,
      isIdle: false,
      getSteeringMessages: vi.fn(() => steering),
    });
    await authority.submit(
      makeRequest("image-a", {
        text: "A",
        requestedMode: "steer",
        images: [{ data: "a" }],
      }),
    );
    await authority.submit(
      makeRequest("image-b", {
        text: "B",
        requestedMode: "steer",
        images: [{ data: "b" }],
      }),
    );
    steering = ["B"];
    authority.publishSnapshot();
    session.clearQueue.mockReturnValueOnce({ steering: ["B"], followUp: [] });

    await authority.requestEscape("ambiguous-images");

    expect(sendRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "queue_restoration",
        steering: ["B"],
        originalAttachments: [
          { intentId: "image-a", images: [{ data: "a" }] },
          { intentId: "image-b", images: [{ data: "b" }] },
        ],
      }),
    );
  });

  it("retires identities when an external queue shrink is observed before delivery", async () => {
    const promptDone = deferred();
    let steering = [];
    const { authority, sendRecord } = setup({
      isStreaming: true,
      getSteeringMessages: vi.fn(() => steering),
      prompt: vi.fn((_text, options) => {
        steering = ["queued"];
        options.preflightResult(true);
        return promptDone.promise;
      }),
    });
    await authority.submit(
      makeRequest("externally-removed", { text: "original", requestedMode: "steer" }),
    );

    steering = [];
    authority.snapshot();
    authority.observeEvent({
      type: "message_start",
      message: { role: "user", content: "independent" },
    });
    expect(sendRecord).toHaveBeenLastCalledWith({
      type: "event",
      event: { type: "message_start", message: { role: "user", content: "independent" } },
    });
    promptDone.resolve();
  });

  it("invalidates identities on an equal-length external queue replacement", async () => {
    const promptDone = deferred();
    let steering = [];
    const { authority, sendRecord } = setup({
      isStreaming: true,
      getSteeringMessages: vi.fn(() => steering),
      prompt: vi.fn((_text, options) => {
        steering = ["queued"];
        options.preflightResult(true);
        return promptDone.promise;
      }),
    });
    await authority.submit(
      makeRequest("externally-replaced", { text: "original", requestedMode: "steer" }),
    );

    steering = ["replacement"];
    authority.snapshot();
    steering = [];
    authority.observeEvent({
      type: "message_start",
      message: { role: "user", content: "replacement delivery" },
    });
    expect(sendRecord).toHaveBeenLastCalledWith({
      type: "event",
      event: {
        type: "message_start",
        message: { role: "user", content: "replacement delivery" },
      },
    });
    promptDone.resolve();
  });

  it("does not decorate a future user event with an intent removed by clearQueue", async () => {
    const promptDone = deferred();
    let steering = [];
    const { authority, sendRecord } = setup({
      isStreaming: true,
      getSteeringMessages: vi.fn(() => steering),
      clearQueue: vi.fn(() => {
        const cleared = [...steering];
        steering = [];
        return { steering: cleared, followUp: [] };
      }),
      prompt: vi.fn((_text, options) => {
        steering = ["transformed queued"];
        options.preflightResult(true);
        return promptDone.promise;
      }),
    });
    await authority.submit(
      makeRequest("cleared-intent", { text: "original", requestedMode: "steer" }),
    );

    await authority.requestEscape("escape-clear");
    expect(sendRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "queue_restoration",
        clearedIntentIds: ["cleared-intent"],
      }),
    );
    authority.observeEvent({
      type: "message_start",
      message: { role: "user", content: "independent later input" },
    });

    expect(sendRecord).toHaveBeenLastCalledWith({
      type: "event",
      event: {
        type: "message_start",
        message: { role: "user", content: "independent later input" },
      },
    });
    promptDone.resolve();
  });

  it("prunes attachments once their authoritative queued message is consumed", async () => {
    let steering = ["queued image"];
    const { authority, session, sendRecord } = setup({
      isStreaming: true,
      isIdle: false,
      getSteeringMessages: vi.fn(() => steering),
    });
    await authority.submit(
      makeRequest("consumed-image", {
        text: "queued image",
        requestedMode: "steer",
        images: [{ data: "image" }],
      }),
    );
    steering = [];
    authority.publishSnapshot();
    session.clearQueue.mockReturnValueOnce({ steering: [], followUp: [] });

    await authority.requestEscape("after-consumption");

    expect(sendRecord).toHaveBeenCalledWith(
      expect.objectContaining({ type: "queue_restoration", originalAttachments: [] }),
    );
  });

  it("uses every ESC priority and restores cleared streaming queues with their attachments", async () => {
    const { authority, session, sendRecord } = setup({
      getSteeringMessages: vi.fn(() => ["queued"]),
    });
    const nav = deferred();
    const navigation = authority.runNavigation(() => nav.promise);
    await flush();
    await expect(authority.requestEscape("nav")).resolves.toMatchObject({ target: "navigation" });
    nav.resolve();
    await navigation;

    authority.observeEvent({ type: "compaction_start" });
    await expect(authority.requestEscape("compact")).resolves.toMatchObject({
      target: "compaction",
    });
    authority.observeEvent({ type: "compaction_end" });

    session.isRetrying = true;
    await expect(authority.requestEscape("retry")).resolves.toMatchObject({ target: "retry" });
    session.isRetrying = false;

    session.isStreaming = true;
    session.clearQueue.mockReturnValueOnce({ steering: ["queued"], followUp: [] });
    await authority.submit(
      makeRequest("queued-intent", {
        text: "queued",
        requestedMode: "steer",
        images: [{ data: "image" }],
      }),
    );
    const streaming = await authority.requestEscape("stream");
    expect(streaming).toMatchObject({ target: "streaming" });
    expect(sendRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "queue_restoration",
        restorationId: streaming.restorationId,
        steering: ["queued"],
        originalAttachments: [{ intentId: "queued-intent", images: [{ data: "image" }] }],
      }),
    );
    session.isStreaming = false;

    session.isBashRunning = true;
    await expect(authority.requestEscape("bash")).resolves.toMatchObject({ target: "bash" });
    session.isBashRunning = false;
    await expect(authority.requestEscape("idle")).resolves.toMatchObject({
      disposition: "already_inactive",
      target: "editor",
    });

    expect(session.abortBranchSummary).toHaveBeenCalledTimes(1);
    expect(session.abortCompaction).toHaveBeenCalledTimes(1);
    expect(session.abortRetry).toHaveBeenCalledTimes(1);
    expect(session.abort).toHaveBeenCalledTimes(1);
    expect(session.abortBash).toHaveBeenCalledTimes(1);
  });

  it("rejects an editor revision mismatch before prompt admission", async () => {
    const { authority, session, setEditor } = setup();
    setEditor({ revision: 2, text: "new draft" });

    await expect(
      authority.submit(makeRequest("stale", { editorRevision: 1 })),
    ).resolves.toMatchObject({
      disposition: "not_submitted",
      message: "Editor revision changed before submission was accepted",
    });
    expect(session.prompt).not.toHaveBeenCalled();
  });

  it("commits initial binding records with one terminal snapshot without partial control", () => {
    const { authority, sendControl } = setup();
    authority.beginTransition(0, false);
    authority.observeEvent({ type: "agent_start" });

    const batch = authority.commitInitialBinding();

    expect(sendControl).not.toHaveBeenCalled();
    expect(batch.records).toEqual([
      expect.objectContaining({ type: "event", event: { type: "agent_start" } }),
    ]);
    expect(batch.terminalSnapshot).toMatchObject({ sessionEpoch: 0, isStreaming: false });
  });

  it("invalidates a host close token when authoritative state changes", () => {
    const { authority, session } = setup();
    authority.publishSnapshot();
    const checkpoint = authority.prepareClose();
    session.isStreaming = true;
    session.isIdle = false;
    authority.publishSnapshot();

    expect(authority.confirmClose(checkpoint.token)).toMatchObject({ valid: false });
  });

  it("permits the correlated response after a valid close confirmation", () => {
    const { authority } = setup();
    const checkpoint = authority.prepareClose();

    expect(authority.confirmClose(checkpoint.token)).toMatchObject({ valid: true });
    expect(
      authority.captureOutbound({ type: "response", id: "close", closeConfirmation: true }),
    ).toBe(false);
    expect(authority.captureOutbound({ type: "event", event: { type: "late" } })).toBe(true);
  });

  it("includes custody and replicated UI in the host close checkpoint", async () => {
    const getCheckpoint = vi.fn(() => ({
      editor: { revision: 4, text: "draft" },
      unifiedSubmissions: [{ id: "u1", text: "pending", revision: 3 }],
      panels: [{ panelId: 2, lastData: "frame" }],
    }));
    const { authority } = setup({}, { getCheckpoint });
    authority.observeEvent({ type: "compaction_start" });
    await authority.submit(makeRequest("custody"));

    const checkpoint = authority.prepareClose();

    expect(checkpoint.custody).toHaveLength(1);
    expect(checkpoint.activeIntents).toContainEqual({
      intentId: "custody",
      disposition: "custody",
    });
    expect(checkpoint.ui).toEqual(getCheckpoint());
  });

  it("rejects prompt ingress while a replacement transition is active", async () => {
    const { authority, session, sendControl } = setup();
    const transitionId = authority.beginTransition(1);

    await expect(authority.submit(makeRequest("during-replacement"))).resolves.toMatchObject({
      disposition: "not_submitted",
      message: "Session replacement is in progress",
    });

    expect(session.prompt).not.toHaveBeenCalled();
    expect(sendControl).toHaveBeenCalledWith({
      type: "transition_started",
      transitionId,
      provisionalEpoch: 1,
    });
    authority.cancelTransition(session);
  });

  it("keeps a predecessor terminal result out of the successor transition batch", async () => {
    const prompt = deferred();
    const { authority, sendControl, sendRecord } = setup({
      isStreaming: true,
      isIdle: false,
      prompt: vi.fn((_text, options) => {
        options.preflightResult(true);
        return prompt.promise;
      }),
    });

    await expect(authority.submit(makeRequest("predecessor-intent"))).resolves.toMatchObject({
      disposition: "consumed",
      sessionEpoch: 0,
    });
    authority.beginTransition(1);
    authority.adoptSession(makeSession({ sessionId: "replacement" }), 1);
    prompt.resolve();
    await flush();

    expect(sendRecord).toHaveBeenCalledWith({
      type: "submission",
      result: expect.objectContaining({
        intentId: "predecessor-intent",
        disposition: "completed",
        hostInstanceId: "host-1",
        sessionEpoch: 0,
      }),
    });
    authority.commitTransition();
    expect(sendControl).toHaveBeenLastCalledWith({
      type: "transition_batch",
      batch: expect.objectContaining({
        provisionalEpoch: 1,
        records: [],
        terminalSnapshot: expect.objectContaining({ sessionEpoch: 1 }),
      }),
    });
  });

  it("defers full state requests until a provisional transition commits", async () => {
    const { authority } = setup();
    authority.beginTransition(1);
    authority.adoptSession(makeSession({ sessionId: "replacement" }), 1);
    let settled = false;
    const pending = authority.requestFullSnapshot().finally(() => {
      settled = true;
    });
    await flush();
    expect(settled).toBe(false);

    authority.commitTransition();
    await expect(pending).resolves.toMatchObject({ sessionEpoch: 1, sessionId: "replacement" });
  });

  it("buffers transition records in order and commits one terminal direct snapshot", () => {
    const { authority, session, sendControl } = setup({ sessionName: "before" });
    const transitionId = authority.beginTransition(7);
    authority.observeEvent({ type: "event-one" });
    expect(authority.captureOutbound({ type: "panel_update", panelId: "panel-1" })).toEqual({
      provisionalEpoch: 7,
      live: true,
    });
    expect(
      authority.captureOutbound({
        type: "submission_disposition",
        result: { intentId: "predecessor", sessionEpoch: 0 },
      }),
    ).toEqual({ provisionalEpoch: 7, live: true });
    authority.adoptSession({ ...session, sessionName: "terminal" }, 7);
    authority.publishSnapshot();

    const terminal = authority.commitTransition();
    expect(sendControl).toHaveBeenCalledTimes(2);
    expect(sendControl).toHaveBeenNthCalledWith(2, {
      type: "transition_batch",
      batch: expect.objectContaining({
        transitionId,
        provisionalEpoch: 7,
        // Provisional UI/panel records were already published on their live
        // transition channel and are not replayed at commit.
        records: [{ type: "event", event: { type: "event-one" } }],
        terminalSnapshot: terminal,
      }),
    });
    expect(terminal).toMatchObject({ sessionEpoch: 7, sessionName: "terminal" });
  });

  it("does not leave a streaming poll after idle preflight rejection", async () => {
    vi.useFakeTimers();
    const session = makeSession();
    let streamingReads = 0;
    Object.defineProperty(session, "isStreaming", {
      configurable: true,
      get() {
        streamingReads++;
        return false;
      },
    });
    session.prompt = vi.fn(async (_text, options) => {
      options.preflightResult(false);
    });
    const { authority } = setup(session);

    await expect(authority.submit(makeRequest("rejected"))).resolves.toMatchObject({
      disposition: "rejected",
    });
    const readsAfterSettlement = streamingReads;
    await vi.advanceTimersByTimeAsync(100);
    expect(streamingReads).toBe(readsAfterSettlement);
  });

  it("retires a hung timed-out admission made during an active turn", async () => {
    vi.useFakeTimers();
    const pending = deferred();
    const onAdmissionStuck = vi.fn();
    const { authority } = setup(
      {
        isStreaming: true,
        isIdle: false,
        prompt: vi.fn(() => pending.promise),
      },
      { onAdmissionStuck },
    );

    const result = authority.submit(makeRequest("active-turn-hang"));
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(result).resolves.toMatchObject({ disposition: "outcome_unknown" });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(onAdmissionStuck).toHaveBeenCalledWith({
      intentId: "active-turn-hang",
      sessionEpoch: 0,
    });
    pending.resolve();
    await flush();
  });

  it("retains active-turn images while timed-out admission remains uncertain", async () => {
    vi.useFakeTimers();
    const pending = deferred();
    let steering = [];
    const { authority, session, sendRecord } = setup({
      isStreaming: true,
      isIdle: false,
      getSteeringMessages: vi.fn(() => steering),
      prompt: vi.fn(() => pending.promise),
      clearQueue: vi.fn(() => ({ steering: [...steering], followUp: [] })),
    });

    const result = authority.submit(
      makeRequest("slow-image", {
        text: "queued with image",
        requestedMode: "steer",
        images: [{ data: "image-bytes", mimeType: "image/png" }],
      }),
    );
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(result).resolves.toMatchObject({ disposition: "outcome_unknown" });
    steering = ["queued with image"];
    pending.resolve();
    await flush();

    await authority.requestEscape("restore-slow-image");

    expect(session.clearQueue).toHaveBeenCalledTimes(1);
    expect(sendRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "queue_restoration",
        steering: ["queued with image"],
        originalAttachments: [
          {
            intentId: "slow-image",
            images: [{ data: "image-bytes", mimeType: "image/png" }],
          },
        ],
      }),
    );
  });

  it("clears the revision-matched authoritative editor after late admission completes", async () => {
    vi.useFakeTimers();
    const pending = deferred();
    let editor = {
      revision: 1,
      text: "slow prompt",
      attachments: [{ kind: "file", name: "slow.txt" }],
    };
    const acceptEditorSubmission = vi.fn((request) => {
      if (request.editorRevision !== editor.revision) return false;
      editor = { revision: editor.revision + 1, text: "", attachments: [] };
      return true;
    });
    const { authority } = setup(
      { prompt: vi.fn(() => pending.promise) },
      { getEditor: () => editor, acceptEditorSubmission },
    );

    const result = authority.submit(makeRequest("slow", { text: "slow prompt" }));
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(result).resolves.toMatchObject({ disposition: "outcome_unknown" });
    expect(editor.text).toBe("slow prompt");

    pending.resolve();
    await flush();

    expect(acceptEditorSubmission).toHaveBeenCalledWith(
      expect.objectContaining({ intentId: "slow", editorRevision: 1 }),
    );
    expect(editor).toEqual({ revision: 2, text: "", attachments: [] });
  });

  it("does not clear newer editor state when a late admission completes", async () => {
    vi.useFakeTimers();
    const pending = deferred();
    let editor = { revision: 1, text: "slow prompt", attachments: [] };
    const acceptEditorSubmission = vi.fn((request) => {
      if (request.editorRevision !== editor.revision) return false;
      editor = { revision: editor.revision + 1, text: "", attachments: [] };
      return true;
    });
    const { authority } = setup(
      { prompt: vi.fn(() => pending.promise) },
      { getEditor: () => editor, acceptEditorSubmission },
    );

    const result = authority.submit(makeRequest("slow", { text: "slow prompt" }));
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(result).resolves.toMatchObject({ disposition: "outcome_unknown" });
    editor = { revision: 2, text: "new typing", attachments: [{ kind: "file" }] };

    pending.resolve();
    await flush();

    expect(editor).toEqual({
      revision: 2,
      text: "new typing",
      attachments: [{ kind: "file" }],
    });
  });

  it("reports an admission timeout and later records its terminal disposition", async () => {
    vi.useFakeTimers();
    const pending = deferred();
    const onAdmissionStuck = vi.fn();
    const { authority, sendRecord } = setup(
      { prompt: vi.fn(() => pending.promise) },
      { onAdmissionStuck },
    );

    const result = authority.submit(makeRequest("slow"));
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(result).resolves.toMatchObject({ disposition: "outcome_unknown" });
    expect(authority.snapshot().hostFacts.submitting).toBe(true);
    await expect(authority.requestEscape("stuck-escape")).resolves.toMatchObject({
      disposition: "outcome_unknown",
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(onAdmissionStuck).toHaveBeenCalledWith({ intentId: "slow", sessionEpoch: 0 });

    pending.resolve();
    await flush();
    expect(sendRecord).toHaveBeenCalledWith({
      type: "submission",
      result: expect.objectContaining({ intentId: "slow", disposition: "completed" }),
    });
  });
});
