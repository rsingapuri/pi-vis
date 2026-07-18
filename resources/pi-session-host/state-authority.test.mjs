import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AgentSessionSnapshotSchema,
  AuthorityAttachBaselineSchema,
  AuthorityFrameSchema,
  SemanticSnapshotSchema,
} from "../../src/shared/pi-protocol/runtime-state.ts";
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

async function readyAttach(authority, rendererGeneration, presentation) {
  const attached = await authority.requestAuthorityAttach(rendererGeneration, presentation);
  expect(attached.status).toBe("ready");
  return attached.baseline;
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
  it("keeps ESC restoration in authority frames and detached attach baselines until acknowledgement", async () => {
    const sendFrame = vi.fn();
    const { authority, session } = setup(
      {
        isStreaming: true,
        isIdle: false,
        getSteeringMessages: vi.fn(() => ["queued bytes"]),
        clearQueue: vi.fn(() => ({ steering: ["queued bytes"], followUp: [] })),
      },
      { sendFrame },
    );
    const image = { mimeType: "image/png", data: "AAEC/frozen" };
    await authority.submit(
      makeRequest("esc-restoration", {
        text: "queued bytes",
        requestedMode: "steer",
        images: [image],
      }),
    );
    await authority.requestEscape("esc");

    const frame = sendFrame.mock.calls
      .map(([value]) => value)
      .find((value) => value.records.some((record) => record.type === "queue_restoration"));
    expect(frame.records).toContainEqual(
      expect.objectContaining({
        type: "queue_restoration",
        steering: ["queued bytes"],
        originalAttachments: [{ intentId: "esc-restoration", images: [image] }],
      }),
    );
    const detached = await readyAttach(authority, 4);
    expect(detached.restorations).toContainEqual(
      expect.objectContaining({ restorationId: expect.any(String), steering: ["queued bytes"] }),
    );
    authority.acknowledgeRestoration(detached.restorations[0].restorationId);
    expect((await readyAttach(authority, 5)).restorations).toEqual([]);
    expect(session.prompt).toHaveBeenCalledTimes(1);
  });

  it("rechecks lifecycle admission on the serialized child queue after a race", async () => {
    const { authority, session } = setup(
      {},
      {
        getCatalog: () => ({ pendingDialogs: 0 }),
        getEditor: () => ({ revision: 0, text: "", attachments: [] }),
      },
    );

    const queuedPermit = authority.requestLifecyclePermit("reload");
    session.isIdle = false;
    session.isStreaming = true;
    await expect(queuedPermit).resolves.toEqual({ allowed: false, reason: "active" });

    session.isIdle = true;
    session.isStreaming = false;
    await expect(authority.requestLifecyclePermit("reload")).resolves.toEqual({
      allowed: true,
      reason: "allowed",
    });
    session.isIdle = false;
    await expect(authority.beginLifecycleTransition("reload")).resolves.toEqual({
      allowed: false,
      reason: "active",
    });
    expect(authority.isTransitioning).toBe(false);
  });

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

  it("decorates an idle prompt's re-entrant direct user echo with its stable intent", async () => {
    const promptDone = deferred();
    const { authority, sendRecord } = setup({
      prompt: vi.fn((_text, options) => {
        options.preflightResult(true);
        authority.observeEvent({
          type: "message_start",
          message: { role: "user", content: "extension-transformed direct prompt" },
        });
        return promptDone.promise;
      }),
    });

    const submission = authority.submit(makeRequest("direct-intent", { text: "original" }));
    await flush();
    expect(sendRecord).toHaveBeenCalledWith({
      type: "event",
      event: {
        type: "message_start",
        message: { role: "user", content: "extension-transformed direct prompt" },
        queueIntentId: "direct-intent",
      },
    });
    promptDone.resolve();
    await submission;
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

  it("claims a queue slot that becomes visible only after preflight returns", async () => {
    const promptDone = deferred();
    let steering = [];
    const sendFrame = vi.fn();
    const { authority } = setup(
      {
        isStreaming: true,
        getSteeringMessages: vi.fn(() => steering),
        prompt: vi.fn((_text, options) => {
          options.preflightResult(true);
          return promptDone.promise;
        }),
        clearQueue: vi.fn(() => {
          const cleared = [...steering];
          steering = [];
          // Real Pi can synchronously publish its empty queue from clearQueue.
          authority.snapshot();
          return { steering: cleared, followUp: [] };
        }),
      },
      { sendFrame },
    );

    await authority.submit(
      makeRequest("intent-delayed-queue", { text: "original", requestedMode: "steer" }),
    );
    expect(authority.snapshot().steeringIntentIds).toEqual([]);

    steering = ["transformed delayed queue"];
    expect(authority.snapshot().steeringIntentIds).toEqual(["intent-delayed-queue"]);
    await authority.requestEscape("esc-delayed-queue");

    const restoration = sendFrame.mock.calls
      .flatMap(([frame]) => frame.records)
      .find((record) => record.type === "queue_restoration");
    expect(restoration).toMatchObject({
      steering: ["transformed delayed queue"],
      clearedIntentIds: ["intent-delayed-queue"],
    });
    promptDone.resolve();
  });

  it("rebuilds a strictly owned queue to remove, edit, and reorder one pending instruction", async () => {
    let steering = [];
    let followUp = [];
    const { authority, session } = setup({
      isStreaming: true,
      isIdle: false,
      getSteeringMessages: vi.fn(() => steering),
      getFollowUpMessages: vi.fn(() => followUp),
      prompt: vi.fn((text, options) => {
        const queue = options.streamingBehavior === "steer" ? steering : followUp;
        queue.push(text);
        options.preflightResult(true);
        return Promise.resolve();
      }),
      clearQueue: vi.fn(() => {
        const cleared = { steering: [...steering], followUp: [...followUp] };
        steering = [];
        followUp = [];
        return cleared;
      }),
      steer: vi.fn(async (text) => {
        steering.push(text);
      }),
      followUp: vi.fn(async (text) => {
        followUp.push(text);
      }),
    });

    await authority.submit(makeRequest("queue-one", { text: "first", requestedMode: "steer" }));
    await authority.submit(makeRequest("queue-two", { text: "second", requestedMode: "steer" }));
    expect(authority.snapshot().steeringIntentIds).toEqual(["queue-one", "queue-two"]);

    await expect(
      authority.manageQueue({
        kind: "manageQueue",
        operation: "move",
        targetIntentId: "queue-two",
        direction: "earlier",
      }),
    ).resolves.toMatchObject({ applied: true, queue: "steer", targetIntentId: "queue-two" });
    expect(steering).toEqual(["second", "first"]);
    expect(authority.snapshot().steeringIntentIds).toEqual(["queue-two", "queue-one"]);

    await expect(
      authority.manageQueue({
        kind: "manageQueue",
        operation: "update",
        targetIntentId: "queue-one",
        text: "first revised",
      }),
    ).resolves.toMatchObject({ applied: true, queue: "steer", targetIntentId: "queue-one" });
    expect(steering).toEqual(["second", "first revised"]);

    await expect(
      authority.manageQueue({
        kind: "manageQueue",
        operation: "remove",
        targetIntentId: "queue-two",
      }),
    ).resolves.toMatchObject({ applied: true, queue: "steer", targetIntentId: "queue-two" });
    expect(steering).toEqual(["first revised"]);
    expect(authority.snapshot().steeringIntentIds).toEqual(["queue-one"]);
    expect(session.clearQueue).toHaveBeenCalledTimes(3);

    await expect(
      authority.manageQueue({
        kind: "manageQueue",
        operation: "clear",
        expectedSteeringIntentIds: ["queue-two"],
        expectedFollowUpIntentIds: [],
      }),
    ).resolves.toMatchObject({ message: expect.stringContaining("changed") });
    expect(session.clearQueue).toHaveBeenCalledTimes(3);

    await expect(
      authority.manageQueue({
        kind: "manageQueue",
        operation: "clear",
        expectedSteeringIntentIds: ["queue-one"],
        expectedFollowUpIntentIds: [],
      }),
    ).resolves.toMatchObject({ applied: true, operation: "clear" });
    expect(steering).toEqual([]);
    expect(authority.snapshot().steeringIntentIds).toEqual([]);
    expect(session.clearQueue).toHaveBeenCalledTimes(4);
  });

  it("removes only the targeted duplicate-text queue item", async () => {
    let steering = [];
    const { authority } = setup({
      isStreaming: true,
      isIdle: false,
      getSteeringMessages: vi.fn(() => steering),
      prompt: vi.fn((text, options) => {
        steering.push(text);
        options.preflightResult(true);
        return Promise.resolve();
      }),
      clearQueue: vi.fn(() => {
        steering = [];
      }),
      steer: vi.fn(async (text) => {
        steering.push(text);
      }),
      followUp: vi.fn(async () => {}),
    });

    await authority.submit(
      makeRequest("duplicate-first", { text: "same text", requestedMode: "steer" }),
    );
    await authority.submit(
      makeRequest("duplicate-second", { text: "same text", requestedMode: "steer" }),
    );
    await expect(
      authority.manageQueue({
        kind: "manageQueue",
        operation: "remove",
        targetIntentId: "duplicate-second",
      }),
    ).resolves.toMatchObject({ applied: true, targetIntentId: "duplicate-second" });

    expect(steering).toEqual(["same text"]);
    expect(authority.snapshot().steeringIntentIds).toEqual(["duplicate-first"]);
  });

  it("refuses to rebuild a queue that contains an external or transformed item", async () => {
    const steering = [];
    const { authority, session } = setup({
      isStreaming: true,
      isIdle: false,
      getSteeringMessages: vi.fn(() => steering),
      prompt: vi.fn((text, options) => {
        steering.push(text);
        options.preflightResult(true);
        return Promise.resolve();
      }),
      clearQueue: vi.fn(() => ({ steering: [], followUp: [] })),
      steer: vi.fn(async () => {}),
      followUp: vi.fn(async () => {}),
    });

    await authority.submit(makeRequest("owned", { text: "plain", requestedMode: "steer" }));
    steering.push("extension-owned");
    authority.snapshot();

    await expect(
      authority.manageQueue({
        kind: "manageQueue",
        operation: "remove",
        targetIntentId: "owned",
      }),
    ).resolves.toMatchObject({
      operation: "remove",
      message: expect.stringContaining("outside Pi-Vis"),
    });
    expect(session.clearQueue).not.toHaveBeenCalled();
  });

  it("refuses to rebuild transformed or attached GUI queue entries", async () => {
    for (const scenario of [
      {
        queuedText: "extension transformed text",
        images: [],
        expectedMessage: "transformed before queuing",
      },
      {
        queuedText: "plain text",
        images: [{ type: "image", data: "AAE=", mimeType: "image/png" }],
        expectedMessage: "has attachments",
      },
    ]) {
      const steering = [];
      const { authority, session } = setup({
        isStreaming: true,
        isIdle: false,
        getSteeringMessages: vi.fn(() => steering),
        prompt: vi.fn((_text, options) => {
          steering.push(scenario.queuedText);
          options.preflightResult(true);
          return Promise.resolve();
        }),
      });

      await authority.submit(
        makeRequest(`unsafe-${scenario.expectedMessage}`, {
          text: "plain text",
          requestedMode: "steer",
          images: scenario.images,
        }),
      );
      expect(authority.semanticSnapshot().queues.management).toMatchObject({
        available: false,
        message: expect.stringContaining(scenario.expectedMessage),
      });
      await expect(
        authority.manageQueue({
          kind: "manageQueue",
          operation: "remove",
          targetIntentId: `unsafe-${scenario.expectedMessage}`,
        }),
      ).resolves.toMatchObject({ message: expect.stringContaining(scenario.expectedMessage) });
      expect(session.clearQueue).not.toHaveBeenCalled();
    }
  });

  it("does not let a pending handled extension command claim a later prompt queue slot", async () => {
    const extensionDone = deferred();
    const normalDone = deferred();
    let steering = [];
    const { authority, sendRecord } = setup({
      isStreaming: true,
      getSteeringMessages: vi.fn(() => steering),
      extensionRunner: {
        getCommand: vi.fn((name) => (name === "e2e-notify" ? { handler: vi.fn() } : undefined)),
      },
      prompt: vi.fn((text, options) => {
        options.preflightResult(true);
        if (text === "/e2e-notify") return extensionDone.promise;
        steering = ["transformed ordinary queue"];
        return normalDone.promise;
      }),
    });

    await authority.submit(
      makeRequest("extension-command", {
        text: "/e2e-notify",
        requestedMode: "steer",
      }),
    );
    expect(authority.snapshot().steeringIntentIds).toEqual([]);

    await authority.submit(
      makeRequest("ordinary-prompt", {
        text: "ordinary queue",
        requestedMode: "steer",
      }),
    );
    expect(authority.snapshot().steeringIntentIds).toEqual(["ordinary-prompt"]);

    steering = [];
    authority.observeEvent({
      type: "message_start",
      message: { role: "user", content: "transformed ordinary delivery" },
    });
    expect(sendRecord).toHaveBeenLastCalledWith({
      type: "event",
      event: {
        type: "message_start",
        message: { role: "user", content: "transformed ordinary delivery" },
        queueIntentId: "ordinary-prompt",
      },
    });
    normalDone.resolve();
    extensionDone.resolve();
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

  it("keeps manual compaction fenced until Pi clears its callback-time getter and compact promise", async () => {
    const { authority, session } = setup();
    const compactId = authority.beginCompactionInvocation("manual-compact");
    session.isCompacting = true;
    authority.observeEvent({ type: "compaction_start" });
    await expect(authority.submit(makeRequest("held-during-manual"))).resolves.toMatchObject({
      disposition: "in_custody",
    });

    // Pi 0.80.6 emits the terminal event while isCompacting is still true.
    authority.observeEvent({ type: "compaction_end" });
    session.isCompacting = false;
    await flush();
    expect(session.prompt).not.toHaveBeenCalled();
    expect(authority.snapshot()).toMatchObject({
      hostFacts: { actualCompaction: true, custodyCount: 1 },
      compaction: { phase: "terminal_success", barrierOpen: true },
    });

    authority.settleCompactionInvocation(compactId);
    await vi.waitFor(() => expect(session.prompt).toHaveBeenCalledTimes(1));
    expect(session.prompt).toHaveBeenCalledWith("held-during-manual", expect.any(Object));
    expect(authority.snapshot()).toMatchObject({
      hostFacts: { actualCompaction: false, custodyCount: 0 },
      compaction: { phase: "terminal_success", barrierOpen: false },
    });
  });

  it("defers automatic-start getter disagreement until callback settlement", async () => {
    const { authority } = setup({ isCompacting: false });
    authority.observeEvent({ type: "compaction_start" });

    expect(authority.snapshot()).toMatchObject({
      hostFacts: { actualCompaction: true },
      compaction: { phase: "active", barrierOpen: true },
    });
    expect(authority.snapshot().hostFacts).not.toHaveProperty("compactionAnomaly");
    expect(authority.snapshot().recentObservedOperations).not.toContainEqual(
      expect.objectContaining({ kind: "compaction", state: "unknown" }),
    );

    // If the getter remains false after Pi's callback stack unwinds, the
    // disagreement is real and the conservative unknown barrier must remain.
    await flush();
    expect(authority.snapshot()).toMatchObject({
      hostFacts: { compactionAnomaly: "getter_event_disagreement" },
      compaction: {
        phase: "active",
        anomaly: "getter_event_disagreement",
        barrierOpen: true,
      },
    });
  });

  it("reconciles automatic compaction after Pi clears its callback-time getter", async () => {
    const { authority, session } = setup();
    authority.observeEvent({ type: "compaction_start" });
    session.isCompacting = true;
    await authority.submit(makeRequest("held-during-auto"));

    authority.observeEvent({ type: "compaction_end" });
    expect(session.prompt).not.toHaveBeenCalled();
    session.isCompacting = false;
    await vi.waitFor(() => expect(session.prompt).toHaveBeenCalledTimes(1));

    expect(session.prompt).toHaveBeenCalledWith("held-during-auto", expect.any(Object));
    expect(authority.snapshot().hostFacts.actualCompaction).toBe(false);
  });

  it("keeps timed-out custody pending and completes it once without replay", async () => {
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
    expect(sendRecord).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "queue_restoration", followUp: ["only once"] }),
    );
    pending.resolve();
    await flush();
    expect(sendRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "submission",
        result: expect.objectContaining({ intentId: "slow-custody", disposition: "completed" }),
      }),
    );
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

  it("does not turn Pi's branch-summarization getter into a phantom compaction", async () => {
    const navigation = deferred();
    const { authority, session } = setup();
    const navigating = authority.runNavigation(() => {
      // Pi's public isCompacting covers branch summarization as well as real
      // context compaction. Navigation is the operation-specific evidence.
      session.isCompacting = true;
      return navigation.promise;
    });
    await flush();

    authority.publishSnapshot();
    expect(authority.semanticSnapshot().activity).toMatchObject({
      navigation: { kind: "navigation", state: "active" },
    });
    // The SDK diagnostic remains raw, proving semantic consumers must not use
    // its branch-summary bit as context-compaction authority.
    expect(authority.semanticSnapshot().sdk.isCompacting).toBe(true);
    expect(authority.semanticSnapshot().activity.compaction).toBeUndefined();
    expect(authority.snapshot().hostFacts.actualCompaction).toBe(false);
    await expect(authority.requestEscape("cancel-navigation")).resolves.toMatchObject({
      target: "navigation",
    });

    session.isCompacting = false;
    navigation.resolve({ cancelled: true });
    await navigating;
    expect(authority.semanticSnapshot().activity.compaction).toBeUndefined();
    expect(authority.snapshot().compaction).toMatchObject({
      phase: "inactive",
      barrierOpen: false,
    });
    await expect(authority.requestEscape("after-navigation")).resolves.not.toMatchObject({
      target: "compaction",
    });
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

    await expect(authority.requestEscape("after-consumption")).resolves.not.toHaveProperty(
      "restorationId",
    );

    expect(sendRecord).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "queue_restoration" }),
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
    await flush();

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

  it("keeps a forced close token valid when authoritative state changes", () => {
    const { authority, session } = setup();
    const checkpoint = authority.prepareClose(true);
    session.isStreaming = true;
    session.isIdle = false;
    authority.publishSnapshot();

    expect(authority.confirmClose(checkpoint.token)).toMatchObject({ valid: true });
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

  it("returns only an opaque token for a forced close", async () => {
    const { authority } = setup();
    authority.observeEvent({ type: "compaction_start" });
    await authority.submit(makeRequest("custody"));

    expect(authority.prepareClose(true)).toEqual({ token: expect.any(String) });
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

  it("keeps the published transport epoch on the predecessor until transition commit", () => {
    const { authority } = setup();

    expect(authority.transportSessionEpoch).toBe(0);
    authority.beginTransition(1);
    authority.adoptSession(makeSession({ sessionId: "replacement" }), 1);

    expect(authority.sessionEpoch).toBe(1);
    expect(authority.transportSessionEpoch).toBe(0);

    authority.commitTransition();
    expect(authority.transportSessionEpoch).toBe(1);
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

  it("keeps a delayed predecessor terminal outcome out of a valid successor frame", async () => {
    const sendFrame = vi.fn();
    const { authority } = setup({}, { sendFrame });
    const owner = { hostInstanceId: "host-1", sessionEpoch: 0 };

    await authority.dispatchIntent(
      {
        intentId: "replacement-owner",
        expectedOwner: owner,
        intent: { kind: "invokeCommand", text: "/new", editorRevision: 1 },
      },
      async () => {
        authority.beginTransition(1);
        authority.adoptSession(makeSession({ sessionId: "successor" }), 1);
        authority.settleTransitionInitiator("replacement-owner", {
          response: { replacement: "new" },
        });
        authority.commitTransition();
        // A delayed completion from the old callback is deduped and cannot
        // append an old-owner record to the successor frame.
        return { response: { replacement: "new" } };
      },
    );
    await vi.waitFor(() =>
      expect(sendFrame.mock.calls.flatMap(([frame]) => frame.records)).toContainEqual(
        expect.objectContaining({
          type: "intent_outcome",
          outcome: expect.objectContaining({
            intentId: "replacement-owner",
            owner,
            state: "completed",
          }),
        }),
      ),
    );
    const frames = sendFrame.mock.calls.map(([frame]) => frame);
    expect(frames.every((frame) => AuthorityFrameSchema.safeParse(frame).success)).toBe(true);
    expect(frames.filter((frame) => frame.owner.sessionEpoch === 1)).toEqual([
      expect.objectContaining({
        records: [],
        terminalSnapshot: expect.objectContaining({
          owner: expect.objectContaining({ sessionEpoch: 1 }),
        }),
      }),
    ]);
  });

  it("returns a real direct snapshot for state_request while separately publishing frames", async () => {
    const sendFrame = vi.fn();
    const { authority } = setup({}, { sendFrame });

    const response = await authority.requestFullSnapshot();

    expect(AgentSessionSnapshotSchema.safeParse(response).success).toBe(true);
    expect(response).not.toHaveProperty("terminalSnapshot");
    expect(sendFrame).toHaveBeenCalledWith(
      expect.objectContaining({ terminalSnapshot: expect.any(Object) }),
    );
  });

  it("keeps the compatibility availability lease alive while publishing semantic frames", () => {
    const sendFrame = vi.fn();
    const { authority, sendControl } = setup({}, { sendFrame });

    const directSnapshot = authority.publishSnapshot();

    expect(AgentSessionSnapshotSchema.safeParse(directSnapshot).success).toBe(true);
    expect(sendFrame).toHaveBeenCalledWith(
      expect.objectContaining({
        terminalSnapshot: expect.objectContaining({
          snapshotSequence: directSnapshot.snapshotSequence,
        }),
      }),
    );
    expect(sendControl).toHaveBeenCalledWith({
      type: "snapshot",
      snapshot: directSnapshot,
      full: false,
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

  it("keeps a hung admission pending after its deadline while this child still owns settlement", async () => {
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
    await expect(result).resolves.toMatchObject({ disposition: "admitting" });
    expect(authority.snapshot().hostFacts.submitting).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(onAdmissionStuck).toHaveBeenCalledWith({
      intentId: "active-turn-hang",
      sessionEpoch: 0,
    });
    pending.resolve();
    await flush();
  });

  it("retains active-turn images while timed-out admission remains pending", async () => {
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
    await expect(result).resolves.toMatchObject({ disposition: "admitting" });
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
    expect(editor.text).toBe("slow prompt");

    await expect(result).resolves.toMatchObject({ disposition: "admitting" });
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
    editor = { revision: 2, text: "new typing", attachments: [{ kind: "file" }] };

    await expect(result).resolves.toMatchObject({ disposition: "admitting" });
    pending.resolve();
    await flush();

    expect(editor).toEqual({
      revision: 2,
      text: "new typing",
      attachments: [{ kind: "file" }],
    });
  });

  it("does not terminally report an admission timeout and records one later disposition", async () => {
    vi.useFakeTimers();
    const pending = deferred();
    const onAdmissionStuck = vi.fn();
    const { authority, sendRecord } = setup(
      { prompt: vi.fn(() => pending.promise) },
      { onAdmissionStuck },
    );

    const result = authority.submit(makeRequest("slow"));
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(result).resolves.toMatchObject({ disposition: "admitting" });
    expect(authority.snapshot().hostFacts.submitting).toBe(true);
    await expect(authority.requestEscape("stuck-escape")).resolves.toMatchObject({
      disposition: "outcome_unknown",
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(onAdmissionStuck).toHaveBeenCalledWith({ intentId: "slow", sessionEpoch: 0 });

    pending.resolve();
    await flush();
    const terminals = sendRecord.mock.calls
      .map(([record]) => record)
      .filter((record) => record.type === "submission" && record.result.intentId === "slow");
    expect(terminals).toEqual([
      expect.objectContaining({ result: expect.objectContaining({ disposition: "completed" }) }),
    ]);
  });

  it("observes an independent compaction from direct getter evidence", () => {
    const { authority } = setup({ isCompacting: true });

    expect(authority.snapshot()).toMatchObject({
      compaction: {
        phase: "active_unknown_origin",
        origin: "getter",
        barrierOpen: true,
        anomaly: "missing_compaction_start",
      },
      hostFacts: { actualCompaction: true },
    });
  });

  it("retains detached compaction boundaries in a bounded journal baseline", () => {
    const { authority, session } = setup({}, { operationJournalCapacity: 2 });
    session.isCompacting = true;
    authority.observeEvent({ type: "compaction_start" });
    session.isCompacting = false;
    authority.observeEvent({ type: "compaction_end" });
    session.isCompacting = true;
    authority.observeEvent({ type: "compaction_start" });

    const baseline = authority.createSemanticFrame();
    expect(baseline.terminalSnapshot).toMatchObject({
      activity: { compaction: { state: "active" } },
      operationJournalLowWatermark: 2,
      operationJournalHighWatermark: 3,
      operationJournalTruncated: true,
    });
    expect(baseline.terminalSnapshot.recentObservedOperations).toHaveLength(2);
  });

  it("serializes an attach after prior boundaries and supplies a journal plus repaint fences", async () => {
    const { authority, session } = setup();
    session.isCompacting = true;
    authority.observeEvent({ type: "compaction_start" });
    const attach = authority.requestAuthorityAttach(7, {
      panels: () => [
        {
          panelId: 4,
          overlay: true,
          unified: false,
          baseline: { revision: 9, repaintRequired: true },
          inputAcknowledgedThrough: 0,
        },
      ],
    });
    session.isCompacting = false;
    authority.observeEvent({ type: "compaction_end" });

    const attached = await attach;
    expect(attached.status).toBe("ready");
    const baseline = attached.baseline;
    expect(baseline.rendererGeneration).toBe(7);
    expect(baseline.semantic.snapshot.activity).toEqual({});
    expect(baseline.operationJournal).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "observed_operation" })]),
    );
    expect(baseline.panels).toHaveLength(1);
    expect(baseline.panels[0]?.panelId).toBe(4);
    expect(baseline.panels[0]?.sync).toMatchObject({
      state: "synchronizing",
      lastCursor: { transportSequence: expect.any(Number) },
      reason: "repaint_required",
    });
    expect(baseline.panels[0]?.keyframe).toEqual({
      kind: "repaint_required",
      renderRevision: 9,
    });
    const nextFrame = authority.commitSemanticFrame();
    expect(nextFrame.transportSequence).toBe(3);
  });

  it("serializes an attach without waiting for long-running ingress", async () => {
    const gate = deferred();
    const { authority } = setup();
    const envelope = {
      intentId: "long-ingress",
      expectedOwner: { hostInstanceId: "host-1", sessionEpoch: 0 },
      intent: { kind: "runBash", command: "sleep 60" },
    };
    await expect(authority.dispatchIntent(envelope, () => gate.promise)).resolves.toMatchObject({
      status: "admitted",
    });
    await vi.waitFor(() =>
      expect(authority.semanticSnapshot().activeIntents).toContainEqual(
        expect.objectContaining({ intentId: "long-ingress", state: "admitted" }),
      ),
    );

    const outcome = await Promise.race([
      authority.requestAuthorityAttach(8),
      new Promise((resolve) => setTimeout(() => resolve("timed_out"), 100)),
    ]);
    gate.resolve({ output: "", exitCode: 0 });
    expect(outcome).toMatchObject({ status: "ready", baseline: { rendererGeneration: 8 } });
  });

  it("keeps the compaction barrier through retry_wait", async () => {
    const { authority, session } = setup();
    authority.observeEvent({ type: "compaction_start" });
    authority.observeEvent({ type: "compaction_end", willRetry: true });

    await expect(authority.submit(makeRequest("retry-held"))).resolves.toMatchObject({
      disposition: "in_custody",
    });
    expect(authority.snapshot().compaction).toMatchObject({
      phase: "retry_wait",
      barrierOpen: true,
    });
    expect(session.prompt).not.toHaveBeenCalled();
  });

  it("keeps custody fenced and reports an anomaly when getter and event disagree", async () => {
    const { authority, session } = setup({ isCompacting: false });
    authority.observeEvent({ type: "compaction_start" });
    await flush();

    expect(authority.snapshot()).toMatchObject({
      compaction: { phase: "active", barrierOpen: true, anomaly: "getter_event_disagreement" },
    });
    await expect(authority.submit(makeRequest("anomaly-held"))).resolves.toMatchObject({
      disposition: "in_custody",
    });
    expect(session.prompt).not.toHaveBeenCalled();
  });

  it("deduplicates identical settled intent IDs and rejects conflicting payloads", async () => {
    const { authority, session } = setup();
    await expect(
      authority.submit(makeRequest("stable-id", { text: "once" })),
    ).resolves.toMatchObject({
      disposition: "consumed",
    });
    await flush();

    await expect(
      authority.submit(makeRequest("stable-id", { text: "once" })),
    ).resolves.toMatchObject({
      disposition: "completed",
    });
    await expect(
      authority.submit(makeRequest("stable-id", { text: "different" })),
    ).resolves.toMatchObject({
      disposition: "rejected",
      message: "Intent ID was reused with a different payload",
    });
    expect(session.prompt).toHaveBeenCalledTimes(1);
    expect(authority.snapshot().recentIntentOutcomes).toContainEqual(
      expect.objectContaining({ intentId: "stable-id", disposition: "completed" }),
    );
  });

  it("records dispatch admission before Pi, retains outcomes, and separates receipt from settlement", async () => {
    const gate = deferred();
    const { authority, sendRecord } = setup();
    const envelope = {
      intentId: "wire-intent",
      expectedOwner: { hostInstanceId: "host-1", sessionEpoch: 0 },
      intent: { kind: "runBash", command: "pwd" },
    };
    let snapshotAtExecution;
    const execute = vi.fn(() => {
      snapshotAtExecution = authority.semanticSnapshot();
      return gate.promise;
    });

    await expect(authority.dispatchIntent(envelope, execute)).resolves.toEqual({
      status: "admitted",
      intentId: "wire-intent",
      owner: envelope.expectedOwner,
    });
    await expect(authority.dispatchIntent(envelope, execute)).resolves.toMatchObject({
      status: "duplicate",
    });
    await expect(
      authority.dispatchIntent(
        { ...envelope, intent: { kind: "runBash", command: "rm -rf /nope" } },
        execute,
      ),
    ).resolves.toMatchObject({ status: "not_admitted", reason: "invalid" });
    await expect(
      authority.dispatchIntent(
        {
          ...envelope,
          intentId: "stale",
          expectedOwner: { hostInstanceId: "old", sessionEpoch: 0 },
        },
        execute,
      ),
    ).resolves.toMatchObject({ status: "not_admitted", reason: "stale_owner" });

    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    expect(snapshotAtExecution.activeIntents).toContainEqual(
      expect.objectContaining({ intentId: "wire-intent", kind: "runBash", state: "admitted" }),
    );
    expect(sendRecord).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "intent_outcome" }),
    );
    expect(authority.failureEscrow().dispatchedIntents).toContainEqual({
      intentId: "wire-intent",
      owner: envelope.expectedOwner,
      kind: "runBash",
      state: "outcome_unknown",
    });
    gate.resolve({ output: "/tmp", exitCode: 0 });
    await vi.waitFor(() =>
      expect(sendRecord).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "intent_outcome",
          outcome: expect.objectContaining({ intentId: "wire-intent", state: "completed" }),
        }),
      ),
    );
  });

  it("retains successful navigate post-state but omits it for cancelled navigation", async () => {
    const sendFrame = vi.fn();
    const { authority } = setup({}, { sendFrame });
    const owner = { hostInstanceId: "host-1", sessionEpoch: 0 };
    const envelope = (intentId) => ({
      intentId,
      expectedOwner: owner,
      intent: { kind: "navigate", targetId: "target-a", summarize: true },
    });

    await authority.dispatchIntent(envelope("navigate-success"), async () => ({
      targetId: "target-a",
      summarized: true,
      editorText: "draft from target",
      leafId: "leaf-a",
      // Pi uses null rather than an omitted parentId for its root entries.
      branch: [{ id: "root-a", parentId: null, type: "message", timestamp: 1 }],
    }));
    await vi.waitFor(() =>
      expect(sendFrame.mock.calls.flatMap(([frame]) => frame.records)).toContainEqual(
        expect.objectContaining({
          type: "intent_outcome",
          outcome: expect.objectContaining({
            intentId: "navigate-success",
            state: "completed",
            result: {
              targetId: "target-a",
              summarized: true,
              editorText: "draft from target",
              leafId: "leaf-a",
              branch: [{ id: "root-a", type: "message", timestamp: 1 }],
            },
          }),
        }),
      ),
    );

    await authority.dispatchIntent(envelope("navigate-cancelled"), async () => ({
      targetId: "target-a",
      cancelled: true,
      branch: [{ id: "stale", type: "message" }],
    }));
    await vi.waitFor(() =>
      expect(sendFrame.mock.calls.flatMap(([frame]) => frame.records)).toContainEqual(
        expect.objectContaining({
          type: "intent_outcome",
          outcome: {
            intentId: "navigate-cancelled",
            owner,
            kind: "navigate",
            state: "cancelled",
            result: { targetId: "target-a" },
          },
        }),
      ),
    );
    expect(
      sendFrame.mock.calls
        .map(([frame]) => frame)
        .every((frame) => AuthorityFrameSchema.safeParse(frame).success),
    ).toBe(true);
  });

  it("settles admitted idle and queued submit intents exactly once with typed public evidence", async () => {
    const idleGate = deferred();
    const sendFrame = vi.fn();
    const { authority, session } = setup(
      {
        prompt: vi.fn((_text, options) => {
          options.preflightResult(true);
          session.isStreaming = true;
          return idleGate.promise;
        }),
      },
      { sendFrame },
    );
    const owner = { hostInstanceId: "host-1", sessionEpoch: 0 };
    const envelope = (intentId) => ({
      intentId,
      expectedOwner: owner,
      intent: {
        kind: "submit",
        editorRevision: 1,
        text: intentId,
        images: [],
        requestedMode: "followUp",
        surface: "composer",
      },
    });

    await expect(
      authority.dispatchIntent(envelope("idle-complete"), (intent) =>
        authority.submit(
          {
            intentId: "idle-complete",
            expectedHostId: "host-1",
            expectedEpoch: 0,
            ...intent,
          },
          true,
        ),
      ),
    ).resolves.toMatchObject({ status: "admitted" });
    await vi.waitFor(() => expect(session.prompt).toHaveBeenCalledOnce());
    expect(
      sendFrame.mock.calls
        .flatMap(([frame]) => frame.records)
        .filter((record) => record.type === "intent_outcome"),
    ).toHaveLength(0);
    idleGate.resolve();
    await vi.waitFor(() =>
      expect(
        sendFrame.mock.calls
          .flatMap(([frame]) => frame.records)
          .filter((record) => record.type === "intent_outcome"),
      ).toHaveLength(1),
    );
    const terminal = sendFrame.mock.calls
      .flatMap(([frame]) => frame.records)
      .find((record) => record.type === "intent_outcome");
    expect(terminal).toMatchObject({
      outcome: {
        intentId: "idle-complete",
        kind: "submit",
        state: "completed",
        result: { disposition: "completed", editorRevision: 1, queued: false },
      },
    });

    session.isStreaming = true;
    const queuedGate = deferred();
    session.prompt.mockImplementation((_text, options) => {
      options.preflightResult(true);
      return queuedGate.promise;
    });
    await authority.dispatchIntent(envelope("queued-complete"), (intent) =>
      authority.submit(
        {
          intentId: "queued-complete",
          expectedHostId: "host-1",
          expectedEpoch: 0,
          ...intent,
        },
        true,
      ),
    );
    await vi.waitFor(() => expect(session.prompt).toHaveBeenCalledTimes(2));
    queuedGate.resolve();
    await vi.waitFor(() =>
      expect(
        sendFrame.mock.calls
          .flatMap(([frame]) => frame.records)
          .filter(
            (record) =>
              record.type === "intent_outcome" && record.outcome.intentId === "queued-complete",
          ),
      ).toHaveLength(1),
    );
    expect(session.prompt).toHaveBeenCalledTimes(2);
  });

  it("settles an admitted extension command failure as one typed failed outcome", async () => {
    const sendFrame = vi.fn();
    const { authority } = setup(
      {
        extensionRunner: { getCommand: vi.fn(() => ({ invocationName: "explode" })) },
        prompt: vi.fn((_text, options) => {
          options.preflightResult(true);
          return Promise.reject(new Error("extension exploded"));
        }),
      },
      { sendFrame },
    );
    const owner = { hostInstanceId: "host-1", sessionEpoch: 0 };
    await authority.dispatchIntent(
      {
        intentId: "extension-failure",
        expectedOwner: owner,
        intent: { kind: "invokeCommand", text: "/explode", editorRevision: 1 },
      },
      (intent) =>
        authority.submit(
          {
            intentId: "extension-failure",
            expectedHostId: "host-1",
            expectedEpoch: 0,
            editorRevision: intent.editorRevision,
            text: intent.text,
            images: [],
            requestedMode: "followUp",
            surface: "composer",
          },
          true,
        ),
    );
    await vi.waitFor(() =>
      expect(
        sendFrame.mock.calls
          .flatMap(([frame]) => frame.records)
          .filter((record) => record.type === "intent_outcome"),
      ).toHaveLength(1),
    );
    const outcome = sendFrame.mock.calls
      .flatMap(([frame]) => frame.records)
      .find((record) => record.type === "intent_outcome").outcome;
    expect(outcome).toMatchObject({
      intentId: "extension-failure",
      kind: "invokeCommand",
      state: "failed",
      error: "extension exploded",
      result: { commandType: "explode", disposition: "extension_error", editorRevision: 1 },
    });
  });

  it("normalizes command, model, and bash outcomes without leaking raw SDK values", async () => {
    const sendFrame = vi.fn();
    const { authority } = setup({}, { sendFrame });
    const owner = { hostInstanceId: "host-1", sessionEpoch: 0 };
    const dispatch = (intentId, intent, execute) =>
      authority.dispatchIntent({ intentId, expectedOwner: owner, intent }, execute);

    await dispatch("bash-result", { kind: "runBash", command: "pwd" }, async () => ({
      output: "/tmp",
      exitCode: 0,
      cancelled: false,
    }));
    await dispatch(
      "model-result",
      { kind: "setModel", provider: "anthropic", modelId: "claude" },
      async () => ({ model: { private: "ignored" } }),
    );
    await dispatch(
      "command-result",
      { kind: "invokeCommand", text: "/test", editorRevision: 1 },
      async () => ({ disposition: "rejected", editorRevision: 1, message: "blocked" }),
    );

    await vi.waitFor(() =>
      expect(
        sendFrame.mock.calls
          .flatMap(([frame]) => frame.records)
          .filter((record) => record.type === "intent_outcome"),
      ).toHaveLength(3),
    );
    const outcomes = sendFrame.mock.calls
      .flatMap(([frame]) => frame.records)
      .filter((record) => record.type === "intent_outcome")
      .map((record) => record.outcome);
    expect(outcomes).toContainEqual(
      expect.objectContaining({
        intentId: "bash-result",
        result: { started: true, output: "/tmp", exitCode: 0, cancelled: false },
      }),
    );
    expect(outcomes).toContainEqual(
      expect.objectContaining({
        intentId: "model-result",
        result: { provider: "anthropic", modelId: "claude" },
      }),
    );
    expect(outcomes).toContainEqual(
      expect.objectContaining({
        intentId: "command-result",
        state: "rejected",
        result: {
          commandType: "test",
          disposition: "rejected",
          editorRevision: 1,
          message: "blocked",
        },
      }),
    );
  });

  it("projects detached and failed agent, retry, bash, navigation, command, and compaction operations", async () => {
    const navigation = deferred();
    const { authority, session } = setup({ isRetrying: true });
    authority.observeEvent({ type: "agent_start" });
    authority.observeEvent({ type: "agent_end", willRetry: true });
    const bashId = authority.beginObservedOperation("bash");
    const commandId = authority.beginObservedOperation("command", "cmd-intent", "invoking");
    const compactId = authority.beginCompactionInvocation("compact-intent");
    const navigating = authority.runNavigation(() => navigation.promise);
    await expect(authority.submit(makeRequest("held-before-compact-start"))).resolves.toMatchObject(
      {
        disposition: "in_custody",
      },
    );

    const attach = await readyAttach(authority, 3);
    expect(attach.operationJournal.map((entry) => entry.record.kind)).toEqual(
      expect.arrayContaining(["agent", "retry", "bash", "navigation", "command"]),
    );
    const semantic = authority.createSemanticFrame().terminalSnapshot;
    expect(semantic.activity).toMatchObject({
      retry: { kind: "retry", state: "waiting" },
      bash: { kind: "bash", state: "active" },
      navigation: { kind: "navigation", state: "active" },
      command: { kind: "command", state: "invoking" },
    });
    // The compact command is an invoking command plus a custody barrier until
    // Pi emits a public start event (or its direct getter becomes true).
    expect(semantic.activity.compaction).toBeUndefined();
    expect(SemanticSnapshotSchema.safeParse(semantic).success).toBe(true);
    expect(authority.snapshot().hostFacts.actualCompaction).toBe(true);
    expect(semantic.recentObservedOperations).toContainEqual(
      expect.objectContaining({ kind: "command", operationId: compactId, state: "invoking" }),
    );
    authority.observeEvent({ type: "agent_start" });
    expect(authority.semanticSnapshot().activity.agent).toMatchObject({
      kind: "agent",
      state: "active",
    });
    expect(semantic.recentObservedOperations).not.toContainEqual(
      expect.objectContaining({ kind: "compaction", state: "active", intentId: "compact-intent" }),
    );
    const escrow = authority.failureEscrow();
    expect(escrow.recentObservedOperations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "bash", operationId: bashId, state: "unknown" }),
        expect.objectContaining({ kind: "navigation", state: "unknown" }),
        expect.objectContaining({ kind: "command", operationId: commandId, state: "unknown" }),
      ]),
    );

    authority.settleObservedOperation("bash", bashId);
    authority.settleObservedOperation("command", commandId);
    authority.settleCompactionInvocation(compactId);
    session.isRetrying = false;
    navigation.resolve({ cancelled: true });
    await navigating;
  });

  it("bounds dispatched intent retention and rejects image payloads over its byte cap", async () => {
    const { authority } = setup(
      {},
      { dispatchedIntentCapacity: 2, dispatchedIntentPayloadBytes: 200 },
    );
    const owner = { hostInstanceId: "host-1", sessionEpoch: 0 };
    const dispatch = (intentId) =>
      authority.dispatchIntent(
        { intentId, expectedOwner: owner, intent: { kind: "runBash", command: "pwd" } },
        async () => ({ output: "/tmp", exitCode: 0 }),
      );

    for (const id of ["one", "two", "three"]) {
      await expect(dispatch(id)).resolves.toMatchObject({ status: "admitted" });
      await vi.waitFor(() =>
        expect(
          authority
            .createSemanticFrame()
            .terminalSnapshot.recentIntentOutcomes.some((outcome) => outcome.intentId === id),
        ).toBe(true),
      );
    }
    expect(authority.createSemanticFrame().terminalSnapshot).toMatchObject({
      dispatchedIntentLowWatermark: 2,
      dispatchedIntentHighWatermark: 3,
      dispatchedIntentTruncated: true,
      recentIntentOutcomes: [
        expect.objectContaining({ intentId: "two" }),
        expect.objectContaining({ intentId: "three" }),
      ],
    });
    await expect(
      authority.dispatchIntent(
        {
          intentId: "too-large",
          expectedOwner: owner,
          intent: {
            kind: "submit",
            editorRevision: 1,
            text: "x",
            images: [
              {
                type: "image",
                mimeType: "image/png",
                data: "image bytes that exceed cap ".repeat(20),
              },
            ],
            requestedMode: "followUp",
            surface: "composer",
          },
        },
        vi.fn(),
      ),
    ).resolves.toEqual({
      status: "not_admitted",
      intentId: "too-large",
      reason: "invalid",
      invalidReason: "payload_too_large",
    });
  });

  it("serializes complete owner-scoped detached operation journals and terminal outcomes", async () => {
    const { authority, session } = setup({}, { operationJournalCapacity: 64 });
    const owner = { hostInstanceId: "host-1", sessionEpoch: 0 };
    const navigation = deferred();
    authority.observeEvent({ type: "agent_start" });
    authority.observeEvent({ type: "agent_end", willRetry: true });
    const bashId = authority.beginObservedOperation("bash", "bash-intent", "active");
    const navigating = authority.runNavigation(() => navigation.promise);
    authority.beginCompactionInvocation("compact-intent");
    // A direct getter/event disagreement is both an operation observation and
    // a typed anomaly entry, retained for a renderer that was detached.
    authority.observeEvent({ type: "compaction_start" });
    session.isCompacting = false;
    authority.snapshot();
    await authority.dispatchIntent(
      {
        intentId: "outcome-intent",
        expectedOwner: owner,
        intent: { kind: "runBash", command: "pwd" },
      },
      async () => ({ output: "/tmp", exitCode: 0 }),
    );
    await vi.waitFor(() =>
      expect(authority.createSemanticFrame().terminalSnapshot.recentIntentOutcomes).toContainEqual(
        expect.objectContaining({ intentId: "outcome-intent", state: "completed" }),
      ),
    );
    authority.settleObservedOperation("bash", bashId, { intentId: "bash-intent" });
    authority.settleCompactionInvocation("compact-intent");
    navigation.resolve();
    await navigating;

    const first = await readyAttach(authority, 11);
    const second = await readyAttach(authority, 12);
    for (const attach of [first, second]) {
      expect(AuthorityAttachBaselineSchema.safeParse(attach).success).toBe(true);
      expect(attach.operationJournal.map((entry) => entry.type)).toEqual(
        expect.arrayContaining(["observed_operation", "intent_outcome", "anomaly"]),
      );
      expect(attach.operationJournal).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "intent_outcome",
            outcome: expect.objectContaining({ intentId: "outcome-intent", owner }),
          }),
          expect.objectContaining({ type: "anomaly", owner }),
        ]),
      );
      expect(
        attach.operationJournal.every((entry) => {
          const entryOwner =
            entry.type === "observed_operation"
              ? entry.record.owner
              : entry.type === "intent_outcome"
                ? entry.outcome.owner
                : entry.owner;
          return (
            entryOwner.hostInstanceId === owner.hostInstanceId &&
            entryOwner.sessionEpoch === owner.sessionEpoch
          );
        }),
      ).toBe(true);
      expect(attach.semantic.snapshot.operationJournalLowWatermark).toBe(
        attach.operationJournal[0].sequence,
      );
      expect(attach.semantic.snapshot.operationJournalHighWatermark).toBe(
        attach.operationJournal.at(-1).sequence,
      );
    }
  });

  it("rejects malformed SessionIntent variants before fingerprinting, journal admission, or SDK execution", async () => {
    const sendFrame = vi.fn();
    const { authority } = setup({}, { sendFrame });
    const owner = { hostInstanceId: "host-1", sessionEpoch: 0 };
    const execute = vi.fn();
    const malformed = [
      { kind: "interrupt", extra: true },
      {
        kind: "submit",
        editorRevision: -1,
        text: "x",
        images: [],
        requestedMode: "later",
        surface: "composer",
      },
      { kind: "compact", instructions: 1 },
      { kind: "invokeCommand", text: "/x", editorRevision: 1, extra: true },
      { kind: "runBash", command: "pwd", excludeFromContext: "no" },
      { kind: "navigate", targetId: "", summarize: "yes" },
      { kind: "setModel", provider: "p", modelId: "" },
      { kind: "setThinking", level: "turbo" },
      { kind: "rename", name: 1 },
      { kind: "reload", extra: true },
      { kind: "export", outputPath: 1 },
      { kind: "unknown" },
    ];
    for (const [index, intent] of malformed.entries()) {
      await expect(
        authority.dispatchIntent(
          { intentId: `bad-${index}`, expectedOwner: owner, intent },
          execute,
        ),
      ).resolves.toEqual({
        status: "not_admitted",
        intentId: `bad-${index}`,
        reason: "invalid",
        invalidReason: "malformed",
      });
    }
    expect(execute).not.toHaveBeenCalled();
    expect(sendFrame).not.toHaveBeenCalled();
    expect((await readyAttach(authority, 1)).operationJournal).toEqual([]);
  });

  it("exposes an atomic semantic frame and failure escrow without inventing a compaction end", () => {
    const sendFrame = vi.fn();
    const { authority, sendRecord, sendControl } = setup({}, { sendFrame });
    authority.observeEvent({ type: "compaction_start" });

    expect(sendFrame).toHaveBeenCalledWith(
      expect.objectContaining({
        records: [{ type: "event", event: { type: "compaction_start" } }],
        terminalSnapshot: expect.objectContaining({
          activity: expect.objectContaining({
            compaction: expect.objectContaining({ state: "active" }),
          }),
        }),
      }),
    );
    expect(sendRecord).not.toHaveBeenCalled();
    expect(sendControl).not.toHaveBeenCalled();
    expect(authority.failureEscrow()).toMatchObject({
      compaction: { state: "outcome_unknown", lastObserved: { phase: "active" } },
    });
  });
});
