import { linkSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
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
  const session = {
    isStreaming: false,
    isIdle: true,
    isCompacting: false,
    isRetrying: false,
    retryAttempt: 0,
    isBashRunning: false,
    model: { provider: "anthropic", id: "claude" },
    thinkingLevel: "medium",
    getAvailableThinkingLevels: vi.fn(() => ["off", "low", "medium", "high"]),
    sessionId: "session-1",
    sessionFile: "/tmp/session.jsonl",
    sessionName: "Session",
    pendingMessageCount: 0,
    getSteeringMessages: vi.fn(() => []),
    getFollowUpMessages: vi.fn(() => []),
    extensionRunner: {
      getCommand: vi.fn(() => undefined),
      hasHandlers: vi.fn(() => false),
    },
    abort: vi.fn(async () => {}),
    abortBranchSummary: vi.fn(),
    abortCompaction: vi.fn(),
    abortRetry: vi.fn(),
    abortBash: vi.fn(),
    clearQueue: vi.fn(() => ({})),
    ...overrides,
  };
  session.prompt ??= vi.fn((text, options) => {
    const commandName = options.expandPromptTemplates ? text.slice(1).split(/\s/, 1)[0] : undefined;
    const disposition =
      commandName && session.extensionRunner.getCommand(commandName)
        ? "handled"
        : session.isStreaming
          ? "queued"
          : "started";
    options.preflightResult(disposition);
    return Promise.resolve();
  });
  return session;
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

function shellIntent(command, excludeFromContext = false, editorRevision = 1) {
  return {
    kind: "runBash",
    command,
    excludeFromContext,
    editorRevision,
    editorText: `${excludeFromContext ? "!!" : "!"}${command}`,
  };
}

function setup(sessionOverrides = {}, options = {}) {
  const session = makeSession(sessionOverrides);
  const sendControl = vi.fn();
  const sendRecord = vi.fn();
  let editor = { revision: 1, text: "draft" };
  const getEditor = options.getEditor ?? (() => editor);
  const acceptEditorSubmission = vi.fn((request) => {
    const current = getEditor() ?? {};
    return request.editorRevision === current.revision;
  });
  const acceptShellEditorSubmission = vi.fn((request) => {
    const current = getEditor() ?? {};
    if (request.editorRevision !== current.revision || request.editorText !== current.text) {
      return false;
    }
    editor = { ...current, revision: current.revision + 1, text: "" };
    return true;
  });
  const publishShellEditorSubmission = vi.fn((request) => {
    const current = getEditor() ?? {};
    return current.revision === request.editorRevision + 1 && current.text === "";
  });
  const rollbackShellEditorSubmission = vi.fn((request) => {
    if (request.surface === "unified") return true;
    const current = getEditor() ?? {};
    if (current.revision !== request.editorRevision + 1 || current.text !== "") return false;
    editor = {
      ...current,
      revision: request.editorRevision,
      text: request.editorText,
    };
    return true;
  });
  const authority = createStateAuthority({
    hostInstanceId: "host-1",
    initialSession: session,
    sendControl,
    sendRecord,
    getCatalog: () => ({ pendingDialogs: 3 }),
    getEditor,
    acceptEditorSubmission,
    acceptShellEditorSubmission,
    publishShellEditorSubmission,
    rollbackShellEditorSubmission,
    ...options,
  });
  return {
    session,
    authority,
    sendControl,
    sendRecord,
    acceptEditorSubmission,
    acceptShellEditorSubmission,
    publishShellEditorSubmission,
    rollbackShellEditorSubmission,
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
    let steering = [];
    const harness = setup(
      {
        isStreaming: true,
        isIdle: false,
        getSteeringMessages: vi.fn(() => steering),
        prompt: vi.fn((text, options) => {
          steering = [text];
          options.preflightResult("queued");
          return Promise.resolve();
        }),
        clearQueue: vi.fn(() => {
          const cleared = [...steering];
          steering = [];
          // Real Pi emits this synchronously after emptying its queues.
          harness.authority.observeEvent({ type: "queue_update", steering: [], followUp: [] });
          return { steering: cleared, followUp: [] };
        }),
      },
      { sendFrame },
    );
    const { authority, session, sendRecord } = harness;
    const image = { mimeType: "image/png", data: "AAEC/frozen" };
    await authority.submit(
      makeRequest("esc-restoration", {
        text: "queued bytes",
        requestedMode: "steer",
        images: [image],
      }),
    );
    // Let the queued prompt promise settle so active-intent retention cannot
    // mask attachment-ledger pruning during the re-entrant queue_update.
    await flush();
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
          inputKind: "slash_command",
          images: [{ data: "image-bytes", mimeType: "image/png" }],
        }),
      ),
    ).resolves.toMatchObject({ disposition: "consumed" });

    expect(session.prompt).toHaveBeenCalledWith(
      "/widget-on",
      expect.objectContaining({ expandPromptTemplates: true }),
    );
    expect(session.prompt.mock.calls[0][1]).not.toHaveProperty("images");
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

  it("uses explicit ordinary input semantics when file context makes transport text start with slash", async () => {
    let steering = [];
    const acceptEditorSubmission = vi.fn(() => true);
    const images = [{ data: "image-bytes", mimeType: "image/png" }];
    const { authority, session } = setup(
      {
        isStreaming: true,
        isIdle: false,
        getSteeringMessages: vi.fn(() => [...steering]),
        prompt: vi.fn((text, options) => {
          steering = [...steering, text];
          options.preflightResult("queued");
          return Promise.resolve();
        }),
      },
      {
        getEditor: () => ({ revision: 1, text: "Explain these notes", attachments: [] }),
        acceptEditorSubmission,
      },
    );
    const text = "/tmp/notes.txt\n\nExplain these notes";

    await expect(
      authority.submit(
        makeRequest("file-prefixed", {
          text,
          inputKind: "ordinary",
          images,
          requestedMode: "steer",
        }),
      ),
    ).resolves.toMatchObject({ disposition: "consumed", queued: true });

    expect(session.prompt).toHaveBeenCalledWith(
      text,
      expect.objectContaining({ images, expandPromptTemplates: false }),
    );
    expect(acceptEditorSubmission).toHaveBeenCalledWith(
      expect.objectContaining({ text, inputKind: "ordinary", images }),
    );
    expect(authority.snapshot().steeringIntentIds).toEqual(["file-prefixed"]);
  });

  it("rejects explicit input classification mismatches before Pi admission", async () => {
    for (const scenario of [
      {
        id: "slash-as-ordinary",
        editorText: "/extension",
        transportText: "/extension",
        inputKind: "ordinary",
      },
      {
        id: "ordinary-as-slash",
        editorText: "Explain these notes",
        transportText: "Explain these notes",
        inputKind: "slash_command",
      },
    ]) {
      const acceptEditorSubmission = vi.fn();
      const { authority, session } = setup(
        {},
        {
          getEditor: () => ({ revision: 1, text: scenario.editorText, attachments: [] }),
          acceptEditorSubmission,
        },
      );

      await expect(
        authority.submit(
          makeRequest(scenario.id, {
            text: scenario.transportText,
            inputKind: scenario.inputKind,
            images: [{ data: "must-not-reach-pi", mimeType: "image/png" }],
          }),
        ),
      ).resolves.toMatchObject({
        disposition: "rejected",
        message: "Submission input classification does not match the authoritative editor",
      });
      expect(session.prompt).not.toHaveBeenCalled();
      expect(acceptEditorSubmission).not.toHaveBeenCalled();
    }
  });

  it("derives legacy classification from raw editor text and retains it through custody", async () => {
    const acceptEditorSubmission = vi.fn(() => true);
    const images = [{ data: "legacy-image", mimeType: "image/png" }];
    const text = "/tmp/notes.txt\n\nExplain these notes";
    const { authority, session } = setup(
      {},
      {
        getEditor: () => ({ revision: 1, text: "Explain these notes", attachments: [] }),
        acceptEditorSubmission,
      },
    );
    authority.observeEvent({ type: "compaction_start" });

    await expect(
      authority.submit(makeRequest("legacy-custody", { text, images })),
    ).resolves.toMatchObject({ disposition: "in_custody" });
    expect(acceptEditorSubmission).toHaveBeenCalledWith(
      expect.objectContaining({ inputKind: "ordinary", text, images }),
    );

    authority.observeEvent({ type: "compaction_end" });
    await vi.waitFor(() =>
      expect(session.prompt).toHaveBeenCalledWith(text, expect.objectContaining({ images })),
    );
  });

  it("returns explicit custody instead of holding IPC behind an unresolved idle prompt fence", async () => {
    const first = deferred();
    const second = deferred();
    let calls = 0;
    const { authority, session, sendRecord } = setup({
      prompt: vi.fn((_text, options) => {
        options.preflightResult("started");
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
        options.preflightResult("started");
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
        steering = ["original"];
        options.preflightResult("queued");
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
        options.preflightResult("started");
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

  it("does not treat a non-growing input-hook queue update as queued acceptance", async () => {
    const promptDone = deferred();
    const harness = setup({
      extensionRunner: {
        getCommand: vi.fn(() => undefined),
        hasHandlers: vi.fn((kind) => kind === "input"),
      },
      prompt: vi.fn((_text, options) => {
        harness.authority.observeEvent(
          { type: "queue_update", steering: [], followUp: [] },
          "direct-after-empty-update",
        );
        options.preflightResult("started");
        harness.authority.observeEvent({
          type: "message_start",
          message: { role: "user", content: "direct after empty queue update" },
        });
        return promptDone.promise;
      }),
    });
    const { authority, sendRecord } = harness;

    const submission = authority.submit(
      makeRequest("direct-after-empty-update", { text: "direct input" }),
    );
    await flush();
    expect(sendRecord).toHaveBeenCalledWith({
      type: "event",
      event: {
        type: "message_start",
        message: { role: "user", content: "direct after empty queue update" },
        queueIntentId: "direct-after-empty-update",
      },
    });
    promptDone.resolve();
    await expect(submission).resolves.toMatchObject({ queued: false });
  });

  it("synchronizes external queue additions before capturing the admission baseline", async () => {
    const promptDone = deferred();
    let steering = [];
    const { authority } = setup({
      isStreaming: true,
      getSteeringMessages: vi.fn(() => steering),
      prompt: vi.fn((_text, options) => {
        steering.push("original");
        options.preflightResult("queued");
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
          options.preflightResult("queued");
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

    steering = ["original"];
    expect(authority.snapshot().steeringIntentIds).toEqual(["intent-delayed-queue"]);
    await authority.requestEscape("esc-delayed-queue");

    const restoration = sendFrame.mock.calls
      .flatMap(([frame]) => frame.records)
      .find((record) => record.type === "queue_restoration");
    expect(restoration).toMatchObject({
      steering: ["original"],
      clearedIntentIds: ["intent-delayed-queue"],
    });
    promptDone.resolve();
  });

  it("keeps an unchanged prompt removable when a passive input handler continues", async () => {
    let steering = [];
    const harness = setup({
      isStreaming: true,
      isIdle: false,
      extensionRunner: {
        getCommand: vi.fn(() => undefined),
        hasHandlers: vi.fn((kind) => kind === "input"),
      },
      getSteeringMessages: vi.fn(() => steering),
      prompt: vi.fn((text, options) => {
        harness.authority.observeInputAdmissionResult(
          "continued-input",
          {
            text,
            images: options.images,
            source: "interactive",
            streamingBehavior: options.streamingBehavior,
          },
          { action: "continue" },
        );
        steering.push(text);
        harness.authority.observeEvent(
          { type: "queue_update", steering: [...steering], followUp: [] },
          "continued-input",
        );
        options.preflightResult("queued");
        return Promise.resolve();
      }),
      clearQueue: vi.fn(() => {
        const cleared = [...steering];
        steering = [];
        return { steering: cleared, followUp: [] };
      }),
    });
    const { authority, session } = harness;

    await authority.submit(
      makeRequest("continued-input", {
        text: "unchanged queued steering",
        requestedMode: "steer",
      }),
    );

    expect(authority.semanticSnapshot().queues).toMatchObject({
      steering: ["unchanged queued steering"],
      steeringIntentIds: ["continued-input"],
      management: {
        available: false,
        message: expect.stringContaining("Input hooks are active"),
        removableIntentIds: ["continued-input"],
      },
    });
    await expect(
      authority.manageQueue({
        kind: "manageQueue",
        operation: "remove",
        targetIntentId: "continued-input",
      }),
    ).resolves.toMatchObject({
      applied: true,
      queue: "steer",
      targetIntentId: "continued-input",
    });
    expect(steering).toEqual([]);
    expect(session.clearQueue).toHaveBeenCalledOnce();
  });

  it("attributes only Pi's raw append after a passive handler queues side-effect work", async () => {
    const promptDone = deferred();
    const steering = [];
    const harness = setup({
      isStreaming: true,
      isIdle: false,
      extensionRunner: {
        getCommand: vi.fn(() => undefined),
        hasHandlers: vi.fn((kind) => kind === "input"),
      },
      getSteeringMessages: vi.fn(() => steering),
      prompt: vi.fn((text, options) => {
        steering.push("handler side effect");
        harness.authority.observeEvent(
          { type: "queue_update", steering: [...steering], followUp: [] },
          "continued-after-side-effect",
        );
        harness.authority.observeInputAdmissionResult(
          "continued-after-side-effect",
          {
            text,
            images: options.images,
            source: "interactive",
            streamingBehavior: options.streamingBehavior,
          },
          { action: "continue" },
        );
        steering.push(text);
        harness.authority.observeEvent(
          { type: "queue_update", steering: [...steering], followUp: [] },
          "continued-after-side-effect",
        );
        options.preflightResult("queued");
        return promptDone.promise;
      }),
    });

    await harness.authority.submit(
      makeRequest("continued-after-side-effect", {
        text: "outer raw prompt",
        requestedMode: "steer",
      }),
    );

    expect(harness.authority.snapshot()).toMatchObject({
      steering: ["handler side effect", "outer raw prompt"],
      steeringIntentIds: [null, "continued-after-side-effect"],
    });
    expect(harness.authority.semanticSnapshot().queues.management).toMatchObject({
      available: false,
      message: expect.stringContaining("outside Pi-Vis"),
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
        options.preflightResult("queued");
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
        return "queued";
      }),
      followUp: vi.fn(async (text) => {
        followUp.push(text);
        return "queued";
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
    for (const call of session.steer.mock.calls) {
      expect(call[2]).toEqual({ source: "interactive" });
    }

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

  it("starts every hook-free replay before the active agent can observe a partial queue", async () => {
    let steering = [];
    let replayCalls = 0;
    let observedDuringReplay;
    const { authority } = setup({
      isStreaming: true,
      isIdle: false,
      getSteeringMessages: vi.fn(() => steering),
      prompt: vi.fn((text, options) => {
        steering.push(text);
        options.preflightResult("queued");
        return Promise.resolve();
      }),
      clearQueue: vi.fn(() => {
        const cleared = { steering: [...steering], followUp: [] };
        steering = [];
        return cleared;
      }),
      steer: vi.fn(async (text) => {
        const replayCall = ++replayCalls;
        // Pi awaits _runInputHandlers() even when hasHandlers("input") is
        // false. The active agent may resume after the first append, so it
        // must already be behind every replay continuation in the microtask
        // queue. A sequential rebuild exposes only "second" here.
        await Promise.resolve();
        steering.push(text);
        if (replayCall === 1) {
          queueMicrotask(() => {
            observedDuringReplay = [...steering];
          });
        }
        return "queued";
      }),
      followUp: vi.fn(async () => "queued"),
    });

    await authority.submit(makeRequest("queue-one", { text: "first", requestedMode: "steer" }));
    await authority.submit(makeRequest("queue-two", { text: "second", requestedMode: "steer" }));

    await expect(
      authority.manageQueue({
        kind: "manageQueue",
        operation: "move",
        targetIntentId: "queue-two",
        direction: "earlier",
      }),
    ).resolves.toMatchObject({ applied: true });
    expect(observedDuringReplay).toEqual(["second", "first"]);
    expect(steering).toEqual(["second", "first"]);
  });

  it("refuses a nonempty queue replay before clearing when input hooks are active", async () => {
    let steering = [];
    const clearQueue = vi.fn(() => {
      const cleared = { steering: [...steering], followUp: [] };
      steering = [];
      return cleared;
    });
    const steer = vi.fn(async (text) => {
      steering.push(text);
      return "queued";
    });
    const harness = setup({
      isStreaming: true,
      isIdle: false,
      extensionRunner: {
        getCommand: vi.fn(() => undefined),
        hasHandlers: vi.fn((kind) => kind === "input"),
      },
      getSteeringMessages: vi.fn(() => steering),
      prompt: vi.fn((text, options) => {
        const intentId = text === "keep" ? "keep" : "remove";
        harness.authority.observeInputAdmissionResult(
          intentId,
          {
            text,
            images: options.images,
            source: "interactive",
            streamingBehavior: options.streamingBehavior,
          },
          { action: "continue" },
        );
        steering.push(text);
        harness.authority.observeEvent(
          { type: "queue_update", steering: [...steering], followUp: [] },
          intentId,
        );
        options.preflightResult("queued");
        return Promise.resolve();
      }),
      clearQueue,
      steer,
      followUp: vi.fn(async () => "queued"),
    });
    const { authority } = harness;

    await authority.submit(makeRequest("keep", { text: "keep", requestedMode: "steer" }));
    await authority.submit(makeRequest("remove", { text: "remove", requestedMode: "steer" }));

    await expect(
      authority.manageQueue({
        kind: "manageQueue",
        operation: "remove",
        targetIntentId: "remove",
      }),
    ).resolves.toMatchObject({
      message: expect.stringContaining("Input hooks are active"),
    });
    expect(clearQueue).not.toHaveBeenCalled();
    expect(steer).not.toHaveBeenCalled();
    expect(steering).toEqual(["keep", "remove"]);
    expect(authority.snapshot().steeringIntentIds).toEqual(["keep", "remove"]);

    // A full clear has no replay and remains safe under the same hook set.
    await expect(
      authority.manageQueue({
        kind: "manageQueue",
        operation: "clear",
        expectedSteeringIntentIds: ["keep", "remove"],
        expectedFollowUpIntentIds: [],
      }),
    ).resolves.toMatchObject({ applied: true, operation: "clear" });
    expect(clearQueue).toHaveBeenCalledOnce();
    expect(steering).toEqual([]);
  });

  it("fails closed when a hook-free public replay reports a non-queued disposition", async () => {
    let steering = [];
    const steer = vi.fn(async () => "handled");
    const { authority } = setup({
      isStreaming: true,
      isIdle: false,
      getSteeringMessages: vi.fn(() => steering),
      prompt: vi.fn((text, options) => {
        steering.push(text);
        options.preflightResult("queued");
        return Promise.resolve();
      }),
      clearQueue: vi.fn(() => {
        const cleared = { steering: [...steering], followUp: [] };
        steering = [];
        return cleared;
      }),
      steer,
      followUp: vi.fn(async () => "queued"),
    });

    await authority.submit(makeRequest("keep", { text: "keep", requestedMode: "steer" }));
    await authority.submit(makeRequest("remove", { text: "remove", requestedMode: "steer" }));

    await expect(
      authority.manageQueue({
        kind: "manageQueue",
        operation: "remove",
        targetIntentId: "remove",
      }),
    ).resolves.toMatchObject({
      uncertain: true,
      message: expect.stringContaining("handled an item"),
    });
    expect(steer).toHaveBeenCalledWith("keep", [], { source: "interactive" });
    expect(authority.snapshot().steeringIntentIds).toEqual([]);
  });

  it("removes only the targeted duplicate-text queue item", async () => {
    let steering = [];
    const { authority } = setup({
      isStreaming: true,
      isIdle: false,
      getSteeringMessages: vi.fn(() => steering),
      prompt: vi.fn((text, options) => {
        steering.push(text);
        options.preflightResult("queued");
        return Promise.resolve();
      }),
      clearQueue: vi.fn(() => {
        steering = [];
      }),
      steer: vi.fn(async (text) => {
        steering.push(text);
        return "queued";
      }),
      followUp: vi.fn(async () => "queued"),
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
        options.preflightResult("queued");
        return Promise.resolve();
      }),
      clearQueue: vi.fn(() => ({ steering: [], followUp: [] })),
      steer: vi.fn(async () => "queued"),
      followUp: vi.fn(async () => "queued"),
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

  it("does not advertise deletion for a transformed GUI submission without stable ownership", async () => {
    const steering = [];
    const { authority, session } = setup({
      isStreaming: true,
      isIdle: false,
      getSteeringMessages: vi.fn(() => steering),
      prompt: vi.fn((_text, options) => {
        steering.push("extension transformed text");
        options.preflightResult("queued");
        return Promise.resolve();
      }),
    });

    await authority.submit(
      makeRequest("transformed", {
        text: "plain text",
        requestedMode: "steer",
      }),
    );
    expect(authority.semanticSnapshot().queues.management).toMatchObject({
      available: false,
      message: expect.stringContaining("outside Pi-Vis"),
    });
    expect(authority.semanticSnapshot().queues.management.removableIntentIds).toBeUndefined();
    await expect(
      authority.manageQueue({
        kind: "manageQueue",
        operation: "remove",
        targetIntentId: "transformed",
      }),
    ).resolves.toMatchObject({ message: expect.stringContaining("already delivered or removed") });
    expect(session.clearQueue).not.toHaveBeenCalled();
  });

  it("removes an unsafe owned target when every remaining queue item is replayable", async () => {
    let steering = [];
    const { authority, session } = setup({
      isStreaming: true,
      isIdle: false,
      getSteeringMessages: vi.fn(() => steering),
      prompt: vi.fn((text, options) => {
        steering.push(text);
        options.preflightResult("queued");
        return Promise.resolve();
      }),
      clearQueue: vi.fn(() => {
        steering = [];
      }),
      steer: vi.fn(async (text) => {
        steering.push(text);
        return "queued";
      }),
      followUp: vi.fn(async () => "queued"),
    });

    await authority.submit(makeRequest("safe", { text: "keep me", requestedMode: "steer" }));
    await authority.submit(
      makeRequest("attached", {
        text: "remove me",
        requestedMode: "steer",
        images: [{ type: "image", data: "AAE=", mimeType: "image/png" }],
      }),
    );

    expect(authority.semanticSnapshot().queues.management).toEqual({
      available: false,
      message: expect.stringContaining("has attachments"),
      removableIntentIds: ["attached"],
    });

    await expect(
      authority.manageQueue({
        kind: "manageQueue",
        operation: "remove",
        targetIntentId: "safe",
      }),
    ).resolves.toMatchObject({ message: expect.stringContaining("has attachments") });
    expect(session.clearQueue).not.toHaveBeenCalled();

    await expect(
      authority.manageQueue({
        kind: "manageQueue",
        operation: "remove",
        targetIntentId: "attached",
      }),
    ).resolves.toMatchObject({
      applied: true,
      queue: "steer",
      targetIntentId: "attached",
    });
    expect(steering).toEqual(["keep me"]);
    expect(authority.snapshot().steeringIntentIds).toEqual(["safe"]);
    expect(session.clearQueue).toHaveBeenCalledOnce();
  });

  it("does not let a pending handled extension command claim a later prompt queue slot", async () => {
    const extensionDone = deferred();
    const normalDone = deferred();
    let steering = [];
    let editorText = "/e2e-notify";
    const { authority, sendRecord } = setup(
      {
        isStreaming: true,
        getSteeringMessages: vi.fn(() => steering),
        extensionRunner: {
          getCommand: vi.fn((name) => (name === "e2e-notify" ? { handler: vi.fn() } : undefined)),
          hasHandlers: vi.fn(() => false),
        },
        prompt: vi.fn((text, options) => {
          if (text === "/e2e-notify") {
            options.preflightResult("handled");
            return extensionDone.promise;
          }
          steering = [text];
          options.preflightResult("queued");
          return normalDone.promise;
        }),
      },
      { getEditor: () => ({ revision: 1, text: editorText, attachments: [] }) },
    );

    await authority.submit(
      makeRequest("extension-command", {
        text: "/e2e-notify",
        inputKind: "slash_command",
        requestedMode: "steer",
      }),
    );
    expect(authority.snapshot().steeringIntentIds).toEqual([]);

    editorText = "ordinary queue";
    await authority.submit(
      makeRequest("ordinary-prompt", {
        text: "ordinary queue",
        inputKind: "ordinary",
        requestedMode: "steer",
      }),
    );
    expect(authority.snapshot().steeringIntentIds).toEqual(["ordinary-prompt"]);

    steering = [];
    authority.observeEvent({
      type: "message_start",
      message: { role: "user", content: "ordinary queue" },
    });
    expect(sendRecord).toHaveBeenLastCalledWith({
      type: "event",
      event: {
        type: "message_start",
        message: { role: "user", content: "ordinary queue" },
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
        options.preflightResult("queued");
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

  it("does not infer GUI ownership for a transformed single queue slot", async () => {
    const promptDone = deferred();
    let steering = [];
    const { authority, sendRecord } = setup({
      isStreaming: true,
      getSteeringMessages: vi.fn(() => steering),
      prompt: vi.fn((_text, options) => {
        steering = ["extension prefix original"];
        options.preflightResult("queued");
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
      steeringIntentIds: [null],
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
      },
    });
    promptDone.resolve();
  });

  it("does not let handled input claim an unrelated sole queue append", async () => {
    const promptDone = deferred();
    let steering = [];
    const harness = setup({
      isStreaming: true,
      isIdle: false,
      extensionRunner: {
        getCommand: vi.fn(() => undefined),
        hasHandlers: vi.fn((kind) => kind === "input"),
      },
      getSteeringMessages: vi.fn(() => steering),
      prompt: vi.fn((_text, options) => {
        steering = ["handled extension work"];
        harness.authority.observeEvent(
          {
            type: "queue_update",
            steering: [...steering],
            followUp: [],
          },
          "handled-normal",
        );
        options.preflightResult("handled");
        return promptDone.promise;
      }),
    });
    const { authority, session } = harness;

    await expect(
      authority.submit(
        makeRequest("handled-normal", {
          text: "GUI text was handled",
          requestedMode: "steer",
        }),
      ),
    ).resolves.toMatchObject({ disposition: "consumed", queued: false });
    expect(authority.snapshot()).toMatchObject({
      steering: ["handled extension work"],
      steeringIntentIds: [null],
    });
    await expect(
      authority.manageQueue({
        kind: "manageQueue",
        operation: "update",
        targetIntentId: "handled-normal",
        text: "must not replace extension work",
      }),
    ).resolves.toMatchObject({
      message: expect.stringContaining("managed outside Pi-Vis"),
    });
    expect(session.clearQueue).not.toHaveBeenCalled();
    promptDone.resolve();
  });

  it("does not consume idle input when streaming appears before delayed preflight rejection", async () => {
    vi.useFakeTimers();
    const promptDone = deferred();
    const { authority, session } = setup({
      prompt: vi.fn(() => {
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

    promptDone.reject(new Error("input rejected"));
    await expect(pending).resolves.toMatchObject({ disposition: "rejected" });
  });

  it("does not attach a rejected idle admission's images to unrelated hook-started work", async () => {
    vi.useFakeTimers();
    const promptDone = deferred();
    const image = { data: "rejected-image", mimeType: "image/png" };
    let steering = [];
    const harness = setup({
      extensionRunner: {
        getCommand: vi.fn(() => undefined),
        hasHandlers: vi.fn((kind) => kind === "input"),
      },
      getSteeringMessages: vi.fn(() => steering),
      clearQueue: vi.fn(() => {
        const cleared = [...steering];
        steering = [];
        harness.authority.observeEvent({ type: "queue_update", steering: [], followUp: [] });
        return { steering: cleared, followUp: [] };
      }),
      prompt: vi.fn(() => {
        // The hook starts unrelated work in the same lane, then remains
        // unresolved beyond the diagnostic admission deadline.
        harness.session.isStreaming = true;
        harness.session.isIdle = false;
        steering = ["unrelated hook work"];
        harness.authority.observeEvent(
          { type: "queue_update", steering: [...steering], followUp: [] },
          "idle-rejected-image",
        );
        return promptDone.promise;
      }),
    });
    const { authority, sendRecord } = harness;

    const pending = authority.submit(
      makeRequest("idle-rejected-image", {
        text: "eventually rejected",
        requestedMode: "steer",
        images: [image],
      }),
    );
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(pending).resolves.toMatchObject({ disposition: "admitting" });

    promptDone.reject(new Error("input rejected"));
    await flush();
    await authority.requestEscape("esc-unrelated-hook-work");

    expect(sendRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "queue_restoration",
        steering: ["unrelated hook work"],
        originalAttachments: [],
        certainty: "not_processed",
      }),
    );
  });

  it("reports uncertainty when prompt rejects after successful idle preflight", async () => {
    const acceptEditorSubmission = vi.fn();
    const { authority } = setup(
      {
        prompt: vi.fn((_text, options) => {
          options.preflightResult("started");
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

  it("fences a post-hook admission from starting a new turn after streaming Escape", async () => {
    const inputHook = deferred();
    const image = { data: "pending-image", mimeType: "image/png" };
    const startedTurns = [];
    const harness = setup({
      isStreaming: true,
      isIdle: false,
      abort: vi.fn(() => {
        harness.session.isStreaming = false;
        harness.session.isIdle = true;
        return Promise.resolve();
      }),
      prompt: vi.fn(async (text, options) => {
        // Mirror Pi's public prompt branch after its awaited input hook.
        await inputHook.promise;
        if (harness.session.isStreaming) {
          options.preflightResult("queued");
          return;
        }
        // Pi invokes this immediately before _runAgentPrompt(). The host
        // fence must throw here so this post-abort branch never starts.
        options.preflightResult("started");
        startedTurns.push(text);
      }),
    });
    const { authority, session, sendRecord } = harness;

    const pending = authority.submit(
      makeRequest("pending-steer", {
        text: "must not restart",
        requestedMode: "steer",
        images: [image],
      }),
    );
    await flush();
    expect(session.prompt).toHaveBeenCalledTimes(1);

    const escaped = await authority.requestEscape("esc-preflight");
    expect(escaped).toMatchObject({
      disposition: "abort_requested",
      target: "streaming",
      restorationId: expect.any(String),
    });
    expect(session.abort).toHaveBeenCalledTimes(1);
    expect(session.clearQueue).toHaveBeenCalledTimes(1);
    expect(session.abort.mock.invocationCallOrder[0]).toBeLessThan(
      session.clearQueue.mock.invocationCallOrder[0],
    );
    expect(sendRecord).toHaveBeenCalledWith({
      type: "queue_restoration",
      restorationId: escaped.restorationId,
      steering: ["must not restart"],
      followUp: [],
      originalAttachments: [{ intentId: "pending-steer", images: [image] }],
      clearedIntentIds: ["pending-steer"],
      certainty: "unknown",
    });
    await expect(pending).resolves.toMatchObject({
      intentId: "pending-steer",
      disposition: "outcome_unknown",
    });
    expect(authority.snapshot().hostFacts.submitting).toBe(true);

    inputHook.resolve();
    await flush();

    expect(startedTurns).toEqual([]);
    expect(session.prompt).toHaveBeenCalledTimes(1);
    expect(authority.snapshot().hostFacts.submitting).toBe(false);
    const terminalResults = sendRecord.mock.calls
      .map(([record]) => record)
      .filter(
        (record) => record.type === "submission" && record.result.intentId === "pending-steer",
      );
    expect(terminalResults).toEqual([
      expect.objectContaining({
        result: expect.objectContaining({ disposition: "outcome_unknown" }),
      }),
    ]);
  });

  it("classifies an idle admission queued after an input hook starts a turn", async () => {
    const inputHook = deferred();
    const image = { data: "dynamic-image", mimeType: "image/png" };
    let steering = [];
    const harness = setup({
      extensionRunner: {
        getCommand: vi.fn(() => undefined),
        hasHandlers: vi.fn((kind) => kind === "input"),
      },
      getSteeringMessages: vi.fn(() => steering),
      clearQueue: vi.fn(() => {
        const cleared = [...steering];
        steering = [];
        harness.authority.observeEvent({ type: "queue_update", steering: [], followUp: [] });
        return { steering: cleared, followUp: [] };
      }),
      prompt: vi.fn(async (text, options) => {
        // An input hook can use Pi's public sendMessage({ triggerTurn: true })
        // while prompt() is awaiting the hook, changing the branch Pi takes.
        harness.session.isStreaming = true;
        harness.session.isIdle = false;
        await inputHook.promise;
        steering.push(text);
        harness.authority.observeEvent(
          { type: "queue_update", steering: [...steering], followUp: [] },
          "idle-to-streaming",
        );
        // The prior turn can settle after Pi's synchronous queue_update but
        // before the immediately following preflight callback.
        harness.session.isStreaming = false;
        harness.session.isIdle = true;
        options.preflightResult("queued");
      }),
    });
    const { authority, sendRecord } = harness;

    const pending = authority.submit(
      makeRequest("idle-to-streaming", {
        text: "queued after hook",
        requestedMode: "steer",
        images: [image],
      }),
    );
    await flush();
    inputHook.resolve();

    await expect(pending).resolves.toMatchObject({ disposition: "consumed", queued: true });
    await flush();
    authority.observeEvent({
      type: "message_start",
      message: { role: "user", content: "unrelated direct echo" },
    });
    expect(sendRecord).toHaveBeenCalledWith({
      type: "event",
      event: {
        type: "message_start",
        message: { role: "user", content: "unrelated direct echo" },
      },
    });
    harness.session.isStreaming = true;
    harness.session.isIdle = false;
    await authority.requestEscape("esc-dynamic-queue");

    expect(sendRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "queue_restoration",
        steering: ["queued after hook"],
        originalAttachments: [{ intentId: "idle-to-streaming", images: [image] }],
        certainty: "not_processed",
      }),
    );
  });

  it("clears a cancelled prompt queued after an idle input hook starts a turn", async () => {
    const inputHook = deferred();
    const abortDone = deferred();
    const image = { data: "dynamic-cancel-image", mimeType: "image/png" };
    const startedTurns = [];
    let steering = [];
    const harness = setup({
      extensionRunner: {
        getCommand: vi.fn(() => undefined),
        hasHandlers: vi.fn((kind) => kind === "input"),
      },
      getSteeringMessages: vi.fn(() => steering),
      abort: vi.fn(() => abortDone.promise),
      clearQueue: vi.fn(() => {
        const cleared = [...steering];
        steering = [];
        harness.authority.observeEvent({ type: "queue_update", steering: [], followUp: [] });
        return { steering: cleared, followUp: [] };
      }),
      prompt: vi.fn(async (text, options) => {
        // Abort has been signalled but can remain observably streaming while
        // Pi waits for its active turn to settle.
        harness.session.isStreaming = true;
        harness.session.isIdle = false;
        await inputHook.promise;
        steering.push(text);
        harness.authority.observeEvent(
          { type: "queue_update", steering: [...steering], followUp: [] },
          "idle-dynamic-cancel",
        );
        options.preflightResult("queued");
        startedTurns.push(text);
      }),
    });
    const { authority, session, sendRecord } = harness;

    const pending = authority.submit(
      makeRequest("idle-dynamic-cancel", {
        text: "must be cleared after hook",
        requestedMode: "steer",
        images: [image],
      }),
    );
    await flush();

    await authority.requestEscape("esc-idle-dynamic");
    expect(session.abort).toHaveBeenCalledTimes(1);
    expect(session.clearQueue).toHaveBeenCalledTimes(1);

    inputHook.resolve();
    await expect(pending).resolves.toMatchObject({ disposition: "outcome_unknown" });
    await vi.waitFor(() => expect(session.clearQueue).toHaveBeenCalledTimes(2));

    expect(steering).toEqual([]);
    expect(startedTurns).toEqual([]);
    expect(sendRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "queue_restoration",
        steering: ["must be cleared after hook"],
        originalAttachments: [{ intentId: "idle-dynamic-cancel", images: [image] }],
        certainty: "unknown",
      }),
    );
    abortDone.resolve();
  });

  it("clears Pi's enqueue-before-preflight window without consuming later ingress", async () => {
    const inputHook = deferred();
    const image = { data: "late-image", mimeType: "image/png" };
    let steering = [];
    const harness = setup({
      isStreaming: true,
      isIdle: false,
      extensionRunner: {
        getCommand: vi.fn(() => undefined),
        hasHandlers: vi.fn(() => false),
      },
      getSteeringMessages: vi.fn(() => steering),
      clearQueue: vi.fn(() => {
        const cleared = [...steering];
        steering = [];
        harness.authority.observeEvent({
          type: "queue_update",
          steering: [],
          followUp: [],
        });
        return { steering: cleared, followUp: [] };
      }),
      prompt: vi.fn(async (text, options) => {
        if (text === "late cancelled queue") await inputHook.promise;
        // Faithfully model pinned Pi: _queueSteer appends and emits its
        // synchronous queue_update before prompt() invokes preflightResult.
        steering.push(text);
        harness.authority.observeEvent(
          {
            type: "queue_update",
            steering: [...steering],
            followUp: [],
          },
          "late-queue",
        );
        await Promise.resolve();
        options.preflightResult("queued");
      }),
    });
    const { authority, session, sendRecord } = harness;
    const cancelled = authority.submit(
      makeRequest("late-queue", {
        text: "late cancelled queue",
        requestedMode: "steer",
        images: [image],
      }),
    );
    await flush();

    const escaped = await authority.requestEscape("esc-late-queue");
    expect(session.abort).toHaveBeenCalledTimes(1);
    expect(session.clearQueue).toHaveBeenCalledTimes(1);
    await expect(cancelled).resolves.toMatchObject({ disposition: "outcome_unknown" });

    const later = authority.submit(
      makeRequest("after-escape", {
        text: "after escape",
        requestedMode: "steer",
      }),
    );
    await expect(later).resolves.toMatchObject({ disposition: "in_custody" });
    expect(session.prompt).toHaveBeenCalledTimes(1);

    inputHook.resolve();
    await vi.waitFor(() => expect(session.prompt).toHaveBeenCalledTimes(2));
    await flush();

    // The second clear removes the cancelled prompt from both Pi queue layers.
    // The post-Escape prompt entered Pi only after that cleanup completed.
    expect(session.clearQueue).toHaveBeenCalledTimes(2);
    expect(steering).toEqual(["after escape"]);
    expect(sendRecord).toHaveBeenCalledWith({
      type: "queue_restoration",
      restorationId: escaped.restorationId,
      steering: ["late cancelled queue"],
      followUp: [],
      originalAttachments: [{ intentId: "late-queue", images: [image] }],
      clearedIntentIds: ["late-queue"],
      certainty: "unknown",
    });
    expect(
      sendRecord.mock.calls
        .map(([record]) => record)
        .filter((record) => record.type === "queue_restoration"),
    ).toHaveLength(1);
  });

  it("restores handled-input same-lane work instead of treating it as the cancelled append", async () => {
    const inputHook = deferred();
    let steering = [];
    const harness = setup({
      isStreaming: true,
      isIdle: false,
      extensionRunner: {
        getCommand: vi.fn(() => undefined),
        hasHandlers: vi.fn((kind) => kind === "input"),
      },
      getSteeringMessages: vi.fn(() => steering),
      clearQueue: vi.fn(() => {
        const cleared = [...steering];
        steering = [];
        harness.authority.observeEvent({
          type: "queue_update",
          steering: [],
          followUp: [],
        });
        return { steering: cleared, followUp: [] };
      }),
      prompt: vi.fn(async (_text, options) => {
        await inputHook.promise;
        // A handled input hook may enqueue its own work and then consume the
        // submitted prompt without Pi automatically appending it.
        steering.push("extension-owned same lane");
        harness.authority.observeEvent(
          {
            type: "queue_update",
            steering: [...steering],
            followUp: [],
          },
          "handled-cancelled",
        );
        options.preflightResult("handled");
      }),
    });
    const { authority, session, sendRecord } = harness;
    const cancelled = authority.submit(
      makeRequest("handled-cancelled", {
        text: "handled submission",
        requestedMode: "steer",
      }),
    );
    await flush();

    await authority.requestEscape("esc-handled");
    await expect(cancelled).resolves.toMatchObject({ disposition: "outcome_unknown" });
    inputHook.resolve();
    await vi.waitFor(() => expect(session.clearQueue).toHaveBeenCalledTimes(2));

    expect(steering).toEqual([]);
    expect(
      sendRecord.mock.calls
        .map(([record]) => record)
        .filter((record) => record.type === "queue_restoration"),
    ).toEqual([
      expect.objectContaining({
        steering: ["handled submission"],
        clearedIntentIds: ["handled-cancelled"],
        certainty: "unknown",
      }),
      expect.objectContaining({
        steering: ["extension-owned same lane"],
        clearedIntentIds: [],
        certainty: "not_processed",
      }),
    ]);
  });

  it("removes the attributed cancelled slot when unrelated work appends after it", async () => {
    const inputHook = deferred();
    let steering = [];
    const harness = setup({
      isStreaming: true,
      isIdle: false,
      extensionRunner: {
        getCommand: vi.fn(() => undefined),
        hasHandlers: vi.fn(() => false),
      },
      getSteeringMessages: vi.fn(() => steering),
      clearQueue: vi.fn(() => {
        const cleared = [...steering];
        steering = [];
        harness.authority.observeEvent({
          type: "queue_update",
          steering: [],
          followUp: [],
        });
        return { steering: cleared, followUp: [] };
      }),
      prompt: vi.fn(async (text, options) => {
        await inputHook.promise;
        steering.push(text);
        harness.authority.observeEvent(
          {
            type: "queue_update",
            steering: [...steering],
            followUp: [],
          },
          "cancelled-before-unrelated",
        );
        // _queueSteer emits before awaiting agent.steer(). Unrelated work can
        // append during that await, so the cancelled slot need not be newest.
        await Promise.resolve();
        steering.push("unrelated after cancelled");
        harness.authority.observeEvent(
          {
            type: "queue_update",
            steering: [...steering],
            followUp: [],
          },
          "cancelled-before-unrelated",
        );
        options.preflightResult("queued");
      }),
    });
    const { authority, session, sendRecord } = harness;
    const cancelled = authority.submit(
      makeRequest("cancelled-before-unrelated", {
        text: "cancelled first",
        requestedMode: "steer",
      }),
    );
    await flush();

    await authority.requestEscape("esc-before-unrelated");
    await expect(cancelled).resolves.toMatchObject({ disposition: "outcome_unknown" });
    inputHook.resolve();
    await vi.waitFor(() => expect(session.clearQueue).toHaveBeenCalledTimes(2));

    expect(steering).toEqual([]);
    expect(
      sendRecord.mock.calls
        .map(([record]) => record)
        .filter((record) => record.type === "queue_restoration"),
    ).toEqual([
      expect.objectContaining({
        steering: ["cancelled first"],
        clearedIntentIds: ["cancelled-before-unrelated"],
        certainty: "unknown",
      }),
      expect.objectContaining({
        steering: ["unrelated after cancelled"],
        clearedIntentIds: [],
        certainty: "not_processed",
      }),
    ]);
  });

  it("does not duplicate an attributed cancelled slot cleared by the immediate Escape", async () => {
    const queueAppend = deferred();
    let steering = [];
    const harness = setup({
      isStreaming: true,
      isIdle: false,
      extensionRunner: {
        getCommand: vi.fn(() => undefined),
        hasHandlers: vi.fn(() => false),
      },
      getSteeringMessages: vi.fn(() => steering),
      clearQueue: vi.fn(() => {
        const cleared = [...steering];
        steering = [];
        harness.authority.observeEvent({
          type: "queue_update",
          steering: [],
          followUp: [],
        });
        return { steering: cleared, followUp: [] };
      }),
      prompt: vi.fn(async (text, options) => {
        steering.push(text);
        harness.authority.observeEvent(
          {
            type: "queue_update",
            steering: [...steering],
            followUp: [],
          },
          "already-appended",
        );
        await queueAppend.promise;
        options.preflightResult("queued");
      }),
    });
    const { authority, sendRecord } = harness;
    const cancelled = authority.submit(
      makeRequest("already-appended", {
        text: "already appended",
        requestedMode: "steer",
      }),
    );
    await vi.waitFor(() => expect(steering).toEqual(["already appended"]));

    const escaped = await authority.requestEscape("esc-already-appended");
    await expect(cancelled).resolves.toMatchObject({ disposition: "outcome_unknown" });
    expect(
      sendRecord.mock.calls
        .map(([record]) => record)
        .filter((record) => record.type === "queue_restoration"),
    ).toEqual([
      expect.objectContaining({
        restorationId: escaped.restorationId,
        steering: ["already appended"],
        clearedIntentIds: ["already-appended"],
        certainty: "unknown",
      }),
    ]);

    queueAppend.resolve();
    await flush();
  });

  it("keeps a permanent admission fence when late queue cleanup fails", async () => {
    const inputHook = deferred();
    const onAdmissionStuck = vi.fn();
    let steering = [];
    let clearCount = 0;
    const harness = setup(
      {
        isStreaming: true,
        isIdle: false,
        extensionRunner: {
          getCommand: vi.fn(() => undefined),
          hasHandlers: vi.fn(() => false),
        },
        getSteeringMessages: vi.fn(() => steering),
        clearQueue: vi.fn(() => {
          clearCount++;
          if (clearCount === 2) throw new Error("late clear failed");
          const cleared = [...steering];
          steering = [];
          harness.authority.observeEvent({
            type: "queue_update",
            steering: [],
            followUp: [],
          });
          return { steering: cleared, followUp: [] };
        }),
        prompt: vi.fn(async (text, options) => {
          await inputHook.promise;
          steering.push(text);
          harness.authority.observeEvent(
            {
              type: "queue_update",
              steering: [...steering],
              followUp: [],
            },
            "unsafe-cancelled",
          );
          options.preflightResult("queued");
        }),
      },
      { onAdmissionStuck },
    );
    const { authority, session, sendRecord } = harness;
    const cancelled = authority.submit(
      makeRequest("unsafe-cancelled", {
        text: "unsafe cancelled",
        requestedMode: "steer",
      }),
    );
    await flush();
    await authority.requestEscape("esc-cleanup-failure");
    await expect(cancelled).resolves.toMatchObject({ disposition: "outcome_unknown" });

    await expect(
      authority.submit(
        makeRequest("must-remain-custody", {
          text: "must remain custody",
          requestedMode: "steer",
        }),
      ),
    ).resolves.toMatchObject({ disposition: "in_custody" });

    const schedulerGate = deferred();
    const blockerExecute = vi.fn(() => schedulerGate.promise);
    const unsafeExecute = vi.fn(() => ({ applied: true }));
    await expect(
      authority.dispatchIntent(
        {
          intentId: "scheduler-blocker",
          expectedOwner: { hostInstanceId: "host-1", sessionEpoch: 0 },
          intent: { kind: "setThinking", level: "low" },
        },
        blockerExecute,
      ),
    ).resolves.toMatchObject({ status: "admitted" });
    await vi.waitFor(() => expect(blockerExecute).toHaveBeenCalledTimes(1));
    await expect(
      authority.dispatchIntent(
        {
          intentId: "unsafe-queued-mutation",
          expectedOwner: { hostInstanceId: "host-1", sessionEpoch: 0 },
          intent: { kind: "setModel", provider: "anthropic", modelId: "other" },
        },
        unsafeExecute,
      ),
    ).resolves.toMatchObject({ status: "admitted" });

    inputHook.resolve();
    await vi.waitFor(() => expect(onAdmissionStuck).toHaveBeenCalledTimes(1));
    schedulerGate.resolve({ output: "", exitCode: 0 });
    await vi.waitFor(() =>
      expect(sendRecord).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "intent_outcome",
          outcome: expect.objectContaining({
            intentId: "unsafe-queued-mutation",
            state: "outcome_unknown",
          }),
        }),
      ),
    );
    await flush();

    expect(session.clearQueue).toHaveBeenCalledTimes(2);
    expect(session.prompt).toHaveBeenCalledTimes(1);
    expect(unsafeExecute).not.toHaveBeenCalled();
    expect(steering).toEqual(["unsafe cancelled"]);
    expect(authority.snapshot().hostFacts.submitting).toBe(true);
    expect(authority.hasActiveWork).toBe(true);
    await expect(
      authority.dispatchIntent(
        {
          intentId: "unsafe-new-mutation",
          expectedOwner: { hostInstanceId: "host-1", sessionEpoch: 0 },
          intent: { kind: "setModel", provider: "anthropic", modelId: "newer" },
        },
        unsafeExecute,
      ),
    ).resolves.toEqual({
      status: "not_admitted",
      intentId: "unsafe-new-mutation",
      reason: "closing",
    });
  });

  it("publishes one independently reconcilable restoration per cancelled admission", async () => {
    vi.useFakeTimers();
    const firstPrompt = deferred();
    const secondPrompt = deferred();
    const firstImage = { data: "first-image", mimeType: "image/png" };
    const secondImage = { data: "second-image", mimeType: "image/png" };
    const { authority, session, sendRecord } = setup({
      isStreaming: true,
      isIdle: false,
      prompt: vi.fn((text) =>
        text === "first pending" ? firstPrompt.promise : secondPrompt.promise,
      ),
    });

    const first = authority.submit(
      makeRequest("first-pending", {
        text: "first pending",
        requestedMode: "steer",
        images: [firstImage],
      }),
    );
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(first).resolves.toMatchObject({ disposition: "admitting" });

    const second = authority.submit(
      makeRequest("second-pending", {
        text: "second pending",
        requestedMode: "followUp",
        images: [secondImage],
      }),
    );
    await flush();
    expect(session.prompt).toHaveBeenCalledTimes(2);

    const escaped = await authority.requestEscape("esc-two-admissions");
    await expect(second).resolves.toMatchObject({ disposition: "outcome_unknown" });
    const restorationRecords = sendRecord.mock.calls
      .map(([record]) => record)
      .filter((record) => record.type === "queue_restoration");

    expect(restorationRecords).toEqual([
      {
        type: "queue_restoration",
        restorationId: escaped.restorationId,
        steering: ["first pending"],
        followUp: [],
        originalAttachments: [{ intentId: "first-pending", images: [firstImage] }],
        clearedIntentIds: ["first-pending"],
        certainty: "unknown",
      },
      {
        type: "queue_restoration",
        restorationId: expect.any(String),
        steering: [],
        followUp: ["second pending"],
        originalAttachments: [{ intentId: "second-pending", images: [secondImage] }],
        clearedIntentIds: ["second-pending"],
        certainty: "unknown",
      },
    ]);
    expect(restorationRecords[1].restorationId).not.toBe(escaped.restorationId);

    firstPrompt.resolve();
    secondPrompt.resolve();
    await flush();
  });

  it("does not duplicate another cancelled admission cleared by the first late callback", async () => {
    vi.useFakeTimers();
    const resume = deferred();
    const firstAppended = deferred();
    const secondAppended = deferred();
    const releaseSecondCallback = deferred();
    const firstImage = { data: "first-late-image", mimeType: "image/png" };
    const secondImage = { data: "second-late-image", mimeType: "image/png" };
    let steering = [];
    const harness = setup({
      isStreaming: true,
      isIdle: false,
      extensionRunner: {
        getCommand: vi.fn(() => undefined),
        hasHandlers: vi.fn(() => false),
      },
      getSteeringMessages: vi.fn(() => steering),
      clearQueue: vi.fn(() => {
        const cleared = [...steering];
        steering = [];
        harness.authority.observeEvent({
          type: "queue_update",
          steering: [],
          followUp: [],
        });
        return { steering: cleared, followUp: [] };
      }),
      prompt: vi.fn(async (text, options) => {
        await resume.promise;
        if (text === "first late") {
          steering.push(text);
          harness.authority.observeEvent(
            {
              type: "queue_update",
              steering: [...steering],
              followUp: [],
            },
            "first-late",
          );
          firstAppended.resolve();
          await secondAppended.promise;
        } else {
          await firstAppended.promise;
          steering.push(text);
          harness.authority.observeEvent(
            {
              type: "queue_update",
              steering: [...steering],
              followUp: [],
            },
            "second-late",
          );
          secondAppended.resolve();
          await releaseSecondCallback.promise;
        }
        options.preflightResult("queued");
      }),
    });
    const { authority, session, sendRecord } = harness;
    const first = authority.submit(
      makeRequest("first-late", {
        text: "first late",
        requestedMode: "steer",
        images: [firstImage],
      }),
    );
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(first).resolves.toMatchObject({ disposition: "admitting" });
    const second = authority.submit(
      makeRequest("second-late", {
        text: "second late",
        requestedMode: "steer",
        images: [secondImage],
      }),
    );
    await flush();
    expect(session.prompt).toHaveBeenCalledTimes(2);

    await authority.requestEscape("esc-two-late");
    await expect(second).resolves.toMatchObject({ disposition: "outcome_unknown" });
    resume.resolve();
    await firstAppended.promise;
    await secondAppended.promise;
    await flush();
    expect(session.clearQueue).toHaveBeenCalledTimes(2);

    releaseSecondCallback.resolve();
    await flush();
    const restorationRecords = sendRecord.mock.calls
      .map(([record]) => record)
      .filter((record) => record.type === "queue_restoration");
    expect(restorationRecords).toEqual([
      expect.objectContaining({
        steering: ["first late"],
        originalAttachments: [{ intentId: "first-late", images: [firstImage] }],
        clearedIntentIds: ["first-late"],
        certainty: "unknown",
      }),
      expect.objectContaining({
        steering: ["second late"],
        originalAttachments: [{ intentId: "second-late", images: [secondImage] }],
        clearedIntentIds: ["second-late"],
        certainty: "unknown",
      }),
    ]);
  });

  it("drains compaction custody FIFO before a later normal submit and retains a failed suffix", async () => {
    const calls = [];
    const { authority, session, setEditor } = setup({
      prompt: vi.fn((text, options) => {
        calls.push(text);
        if (text === "second") return Promise.reject(new Error("second rejected"));
        options.preflightResult("started");
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
        options.preflightResult("started");
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
    const { authority, session, sendRecord } = setup(
      {
        extensionRunner: { getCommand: vi.fn(() => ({ name: "side-effect" })) },
        prompt: vi.fn(() => Promise.reject(new Error("extension failed before acceptance"))),
      },
      { getEditor: () => ({ revision: 1, text: "/side-effect", attachments: [] }) },
    );
    authority.observeEvent({ type: "compaction_start" });
    await expect(
      authority.submit(
        makeRequest("extension-custody", {
          text: "/side-effect",
          inputKind: "slash_command",
        }),
      ),
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
        options.preflightResult("queued");
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
        options.preflightResult("queued");
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
        steering = ["original"];
        options.preflightResult("queued");
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

  it("signals streaming abort before reporting a queue cleanup failure", async () => {
    const { authority, session, sendRecord } = setup({
      isStreaming: true,
      isIdle: false,
      clearQueue: vi.fn(() => {
        throw new Error("queue cleanup exploded");
      }),
    });

    await expect(authority.requestEscape("cleanup-failure")).resolves.toMatchObject({
      requestId: "cleanup-failure",
      disposition: "failed",
      target: "streaming",
      message:
        "Abort was requested, but queued prompt cleanup/restoration failed: queue cleanup exploded",
    });

    expect(session.abort).toHaveBeenCalledOnce();
    expect(session.abort.mock.invocationCallOrder[0]).toBeLessThan(
      session.clearQueue.mock.invocationCallOrder[0],
    );
    expect(sendRecord).toHaveBeenCalledWith({
      type: "escape",
      result: expect.objectContaining({
        requestId: "cleanup-failure",
        disposition: "failed",
        target: "streaming",
      }),
    });
  });

  it("retains queued image custody when clearQueue throws before changing the queue", async () => {
    let steering = [];
    const image = { data: "image-bytes", mimeType: "image/png" };
    const { authority, session, sendRecord } = setup({
      isStreaming: true,
      isIdle: false,
      getSteeringMessages: vi.fn(() => steering),
      prompt: vi.fn((text, options) => {
        steering = [text];
        options.preflightResult("queued");
        return Promise.resolve();
      }),
      clearQueue: vi
        .fn()
        .mockImplementationOnce(() => {
          throw new Error("queue cleanup exploded");
        })
        .mockImplementationOnce(() => {
          const cleared = [...steering];
          steering = [];
          return { steering: cleared, followUp: [] };
        }),
    });
    await authority.submit(
      makeRequest("cleanup-image", {
        text: "queued with image",
        requestedMode: "steer",
        images: [image],
      }),
    );
    await flush();

    await expect(authority.requestEscape("cleanup-failure")).resolves.toMatchObject({
      disposition: "failed",
      target: "streaming",
    });
    expect(
      sendRecord.mock.calls
        .map(([record]) => record)
        .filter((record) => record.type === "queue_restoration"),
    ).toEqual([]);

    const recovered = await authority.requestEscape("cleanup-retry");
    expect(recovered).toMatchObject({
      disposition: "abort_requested",
      target: "streaming",
      restorationId: expect.any(String),
    });
    expect(sendRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "queue_restoration",
        restorationId: recovered.restorationId,
        steering: ["queued with image"],
        originalAttachments: [{ intentId: "cleanup-image", images: [image] }],
      }),
    );
    expect(session.abort.mock.invocationCallOrder[0]).toBeLessThan(
      session.clearQueue.mock.invocationCallOrder[0],
    );
  });

  it("publishes unknown image custody when clearQueue empties the queue and then throws", async () => {
    let steering = [];
    const image = { data: "image-bytes", mimeType: "image/png" };
    const harness = setup({
      isStreaming: true,
      isIdle: false,
      getSteeringMessages: vi.fn(() => steering),
      prompt: vi.fn((text, options) => {
        steering = [text];
        options.preflightResult("queued");
        return Promise.resolve();
      }),
      clearQueue: vi.fn(() => {
        steering = [];
        harness.authority.observeEvent({ type: "queue_update", steering: [], followUp: [] });
        throw new Error("queue update listener exploded");
      }),
    });
    const { authority } = harness;
    await authority.submit(
      makeRequest("cleanup-image-after-clear", {
        text: "queued with image",
        requestedMode: "steer",
        images: [image],
      }),
    );
    await flush();

    const failed = await authority.requestEscape("cleanup-after-clear");
    expect(failed).toMatchObject({
      disposition: "failed",
      target: "streaming",
      restorationId: expect.any(String),
    });
    expect(harness.sendRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "queue_restoration",
        restorationId: failed.restorationId,
        steering: ["queued with image"],
        originalAttachments: [{ intentId: "cleanup-image-after-clear", images: [image] }],
        clearedIntentIds: ["cleanup-image-after-clear"],
        certainty: "unknown",
      }),
    );
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

  it("admits an early-cleared Unified source by its immutable pending identity", async () => {
    const inspectEditorSubmission = vi.fn((request) =>
      request.surface === "unified" &&
      request.intentId === "unified-source" &&
      request.editorRevision === 1
        ? { accepted: true, text: "review these files" }
        : { accepted: false },
    );
    const acceptEditorSubmission = vi.fn(() => true);
    const { authority, session, setEditor } = setup(
      {},
      { inspectEditorSubmission, acceptEditorSubmission },
    );
    // Pi's editor has already committed its visual clear and advanced while
    // the renderer transforms the frozen source for transport.
    setEditor({ revision: 2, text: "", attachments: [] });

    await expect(
      authority.submit(
        makeRequest("unified-source", {
          surface: "unified",
          editorRevision: 1,
          text: "/tmp/notes.txt\n\nreview these files",
          inputKind: "ordinary",
        }),
      ),
    ).resolves.toMatchObject({ disposition: "consumed" });

    expect(session.prompt).toHaveBeenCalledWith(
      "/tmp/notes.txt\n\nreview these files",
      expect.any(Object),
    );
    expect(acceptEditorSubmission).toHaveBeenCalledWith(
      expect.objectContaining({ intentId: "unified-source", editorRevision: 1 }),
    );
  });

  it("rejects a forged Unified source before any Pi prompt side effect", async () => {
    const inspectEditorSubmission = vi.fn(() => ({ accepted: false }));
    const { authority, session, setEditor } = setup({}, { inspectEditorSubmission });
    setEditor({ revision: 2, text: "newer draft", attachments: [] });

    await expect(
      authority.submit(
        makeRequest("missing-unified-source", {
          surface: "unified",
          editorRevision: 1,
          text: "forged text",
          inputKind: "ordinary",
        }),
      ),
    ).resolves.toMatchObject({ disposition: "not_submitted" });
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

  it("projects a real Pi runtime pin as its canonical source until a genuine successor", async () => {
    const { SessionManager } = await import("@earendil-works/pi-coding-agent");
    const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "pivis-authority-pin-")));
    try {
      const source = path.join(root, "source.jsonl");
      const alias = path.join(root, ".pivis-session-runtime-pin");
      writeFileSync(source, "");
      SessionManager.open(source, root, root).appendSessionInfo("source");
      linkSync(source, alias);
      const resumed = SessionManager.open(alias, root);
      expect(resumed.getSessionFile()).toBe(alias);

      const internalSession = makeSession({
        sessionId: resumed.getSessionId(),
        sessionFile: resumed.getSessionFile(),
      });
      const authority = createStateAuthority({
        hostInstanceId: "host-pinned",
        initialSession: internalSession,
        initialPresentedSessionFile: source,
      });

      expect(authority.snapshot().sessionFile).toBe(source);
      expect((await readyAttach(authority, 1)).transcript).toMatchObject({
        persistedHistoryCursor: source,
        overlapBoundary: `persisted:${source}`,
      });

      // Reload adopts the same AgentSession object and must retain the
      // canonical presentation even though Pi still owns the alias internally.
      authority.beginTransition(1);
      authority.adoptSession(internalSession, 1);
      expect(authority.commitTransition().sessionFile).toBe(source);

      const successorPath = path.join(root, "successor.jsonl");
      writeFileSync(successorPath, "");
      const successorManager = SessionManager.open(successorPath, root, root);
      const successor = makeSession({
        sessionId: successorManager.getSessionId(),
        sessionFile: successorManager.getSessionFile(),
      });
      authority.beginTransition(2);
      authority.adoptSession(successor, 2);
      expect(authority.commitTransition().sessionFile).toBe(successorPath);
      expect((await readyAttach(authority, 2)).transcript).toMatchObject({
        persistedHistoryCursor: successorPath,
        overlapBoundary: `persisted:${successorPath}`,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps a predecessor terminal result out of the successor transition batch", async () => {
    const prompt = deferred();
    const { authority, sendControl, sendRecord } = setup({
      isStreaming: true,
      isIdle: false,
      prompt: vi.fn((_text, options) => {
        options.preflightResult("queued");
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
    const { authority, setEditor } = setup({}, { sendFrame });
    const owner = { hostInstanceId: "host-1", sessionEpoch: 0 };
    setEditor({ revision: 1, text: "/new", attachments: [] });

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
      expect.objectContaining({
        terminalSnapshot: expect.any(Object),
        runtimeResumeState: {
          model: { provider: "anthropic", modelId: "claude" },
          thinkingLevel: "medium",
        },
      }),
    );
  });

  it("represents an authoritative no-model selection explicitly in restart custody", async () => {
    const sendFrame = vi.fn();
    const { authority } = setup({ model: null, thinkingLevel: "off" }, { sendFrame });

    await authority.requestFullSnapshot();

    expect(sendFrame).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeResumeState: { model: null, thinkingLevel: "off" },
      }),
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
    session.prompt = vi.fn(async () => {
      throw new Error("prompt rejected before acceptance");
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

  it("settles an Escape-fenced timed-out admission once as recoverable unknown", async () => {
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
    const escaped = await authority.requestEscape("stuck-escape");
    expect(escaped).toMatchObject({
      disposition: "outcome_unknown",
      restorationId: expect.any(String),
    });
    expect(sendRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "queue_restoration",
        restorationId: escaped.restorationId,
        followUp: ["slow"],
        clearedIntentIds: ["slow"],
        certainty: "unknown",
      }),
    );
    await vi.advanceTimersByTimeAsync(60_000);
    expect(onAdmissionStuck).toHaveBeenCalledWith({ intentId: "slow", sessionEpoch: 0 });

    pending.resolve();
    await flush();
    const terminals = sendRecord.mock.calls
      .map(([record]) => record)
      .filter((record) => record.type === "submission" && record.result.intentId === "slow");
    expect(terminals).toEqual([
      expect.objectContaining({
        result: expect.objectContaining({ disposition: "outcome_unknown" }),
      }),
    ]);
    expect(authority.snapshot().hostFacts.submitting).toBe(false);
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
    const { authority, setEditor } = setup();
    setEditor({ revision: 1, text: "!sleep 60" });
    const envelope = {
      intentId: "long-ingress",
      expectedOwner: { hostInstanceId: "host-1", sessionEpoch: 0 },
      intent: shellIntent("sleep 60"),
    };
    await expect(
      authority.dispatchIntent(envelope, () => ({ deferredOutcome: gate.promise })),
    ).resolves.toMatchObject({ status: "admitted" });
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

  it("projects summarization retry lifecycle without releasing compaction custody", async () => {
    const { authority } = setup({ isCompacting: true });
    authority.observeEvent({ type: "compaction_start", reason: "manual" });
    authority.observeEvent({
      type: "summarization_retry_scheduled",
      attempt: 1,
      maxAttempts: 3,
      delayMs: 100,
      errorMessage: "temporary failure",
    });

    expect(authority.semanticSnapshot().activity.compaction).toMatchObject({
      state: "retry_wait",
      attempt: 1,
    });
    await expect(authority.submit(makeRequest("summarization-retry-held"))).resolves.toMatchObject({
      disposition: "in_custody",
    });

    authority.observeEvent({
      type: "summarization_retry_attempt_start",
      source: "compaction",
      reason: "manual",
    });
    expect(authority.semanticSnapshot().activity.compaction).toMatchObject({
      state: "active",
      attempt: 2,
    });
    authority.observeEvent({ type: "summarization_retry_finished" });
    expect(authority.semanticSnapshot().activity.compaction?.state).toBe("active");
  });

  it("projects branch-summary retry_wait on the active navigation operation", async () => {
    const gate = deferred();
    const { authority } = setup();
    const navigating = authority.runNavigation(() => gate.promise);

    authority.observeEvent({
      type: "summarization_retry_scheduled",
      attempt: 1,
      maxAttempts: 3,
      delayMs: 100,
      errorMessage: "temporary failure",
    });
    expect(authority.semanticSnapshot().activity.navigation?.state).toBe("retry_wait");

    authority.observeEvent({
      type: "summarization_retry_attempt_start",
      source: "branchSummary",
    });
    expect(authority.semanticSnapshot().activity.navigation?.state).toBe("active");
    gate.resolve({ cancelled: false });
    await navigating;
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

  it("rejects a duplicate submission that flips only its input classification", async () => {
    const { authority, session } = setup();
    const ordinary = makeRequest("classification-id", {
      text: "/tmp/notes.txt\n\nExplain these notes",
      inputKind: "ordinary",
    });
    await expect(authority.submit(ordinary)).resolves.toMatchObject({
      disposition: "consumed",
    });
    await flush();

    await expect(
      authority.submit({ ...ordinary, inputKind: "slash_command" }),
    ).resolves.toMatchObject({
      disposition: "rejected",
      message: "Intent ID was reused with a different payload",
    });
    expect(session.prompt).toHaveBeenCalledTimes(1);
  });

  it("exact-binds and preclaims Unified slash source before any command effect", async () => {
    let accepted = false;
    const acceptEditorSubmission = vi.fn((request) => {
      if (request.intentId !== "slash-source" || request.text !== "/safe" || accepted) return false;
      accepted = true;
      return true;
    });
    const { authority } = setup(
      {},
      {
        inspectEditorSubmission: (request) =>
          request.intentId === "slash-source" && !accepted
            ? { accepted: true, text: "/safe" }
            : { accepted: false },
        acceptEditorSubmission,
      },
    );
    const owner = { hostInstanceId: "host-1", sessionEpoch: 0 };
    const effect = vi.fn(async () => ({ response: { ok: true } }));

    await expect(
      authority.dispatchIntent(
        {
          intentId: "slash-source",
          expectedOwner: owner,
          intent: {
            kind: "invokeCommand",
            text: "/different-effect",
            editorRevision: 4,
            surface: "unified",
          },
        },
        effect,
      ),
    ).resolves.toMatchObject({ status: "not_admitted", reason: "stale_editor" });
    expect(effect).not.toHaveBeenCalled();
    expect(acceptEditorSubmission).not.toHaveBeenCalled();

    await expect(
      authority.dispatchIntent(
        {
          intentId: "slash-source",
          expectedOwner: owner,
          intent: {
            kind: "invokeCommand",
            text: "/safe",
            editorRevision: 4,
            surface: "unified",
          },
        },
        effect,
      ),
    ).resolves.toMatchObject({ status: "admitted" });
    expect(acceptEditorSubmission).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(effect).toHaveBeenCalledOnce());
  });

  it("admits one bounded picker continuation without granting arbitrary empty-editor slash text", async () => {
    const { authority, setEditor, acceptEditorSubmission } = setup();
    const owner = { hostInstanceId: "host-1", sessionEpoch: 0 };
    setEditor({ revision: 5, text: "", attachments: [] });
    const effect = vi.fn(async (intent) => ({ action: intent.selection.action }));
    const pickerEnvelope = {
      intentId: "fork-picker-continuation",
      expectedOwner: owner,
      intent: {
        kind: "pickerAction",
        selection: { action: "fork", entryId: "entry-a" },
        surface: "composer",
      },
    };

    await expect(authority.dispatchIntent(pickerEnvelope, effect)).resolves.toMatchObject({
      status: "admitted",
    });
    await expect(authority.dispatchIntent(pickerEnvelope, effect)).resolves.toMatchObject({
      status: "duplicate",
    });
    await vi.waitFor(() => expect(effect).toHaveBeenCalledOnce());
    expect(acceptEditorSubmission).not.toHaveBeenCalled();

    await expect(
      authority.dispatchIntent(
        {
          intentId: "ungranted-empty-editor-slash",
          expectedOwner: owner,
          intent: {
            kind: "invokeCommand",
            text: "/fork entry-a",
            editorRevision: 5,
          },
        },
        vi.fn(),
      ),
    ).resolves.toMatchObject({ status: "not_admitted", reason: "stale_editor" });
  });

  it("preclaims a cleared Unified reload source before scheduling reload", async () => {
    let accepted = false;
    const effect = vi.fn(async () => ({
      successorIdentity: { hostInstanceId: "host-1", sessionEpoch: 1 },
    }));
    const { authority } = setup(
      {},
      {
        inspectEditorSubmission: (request) =>
          request.intentId === "reload-source" && !accepted
            ? { accepted: true, text: "/reload" }
            : { accepted: false },
        acceptEditorSubmission: vi.fn(() => {
          accepted = true;
          return true;
        }),
      },
    );

    await expect(
      authority.dispatchIntent(
        {
          intentId: "reload-source",
          expectedOwner: { hostInstanceId: "host-1", sessionEpoch: 0 },
          intent: {
            kind: "reload",
            editorRevision: 9,
            editorText: "/reload",
            surface: "unified",
          },
        },
        effect,
      ),
    ).resolves.toMatchObject({ status: "admitted" });
    expect(accepted).toBe(true);
    await vi.waitFor(() => expect(effect).toHaveBeenCalledOnce());
  });

  it("records dispatch admission before Pi, retains outcomes, and separates receipt from settlement", async () => {
    const gate = deferred();
    const { authority, sendRecord, setEditor } = setup();
    setEditor({ revision: 1, text: "!pwd" });
    const envelope = {
      intentId: "wire-intent",
      expectedOwner: { hostInstanceId: "host-1", sessionEpoch: 0 },
      intent: shellIntent("pwd"),
    };
    let snapshotAtExecution;
    const execute = vi.fn(() => {
      snapshotAtExecution = authority.semanticSnapshot();
      return { deferredOutcome: gate.promise };
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
      authority.dispatchIntent({ ...envelope, intent: shellIntent("rm -rf /nope") }, execute),
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
    expect(snapshotAtExecution.activeIntents).not.toContainEqual(
      expect.objectContaining({ intentId: "wire-intent" }),
    );
    expect(authority.semanticSnapshot().activeIntents).toContainEqual(
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

  it("consumes an admitted shell draft in authority while preserving staged context across reattach", async () => {
    const terminal = deferred();
    const { authority, setEditor, acceptShellEditorSubmission, publishShellEditorSubmission } =
      setup();
    const attachments = [{ kind: "file", name: "notes.txt", path: "/tmp/notes.txt" }];
    setEditor({
      revision: 1,
      text: "!read answer",
      attachments,
      conflictText: "newer draft",
      conflictAttachments: [{ kind: "file", name: "new.txt", path: "/tmp/new.txt" }],
      alternateConflictText: "alternate draft",
      alternateConflictAttachments: [],
      additionalConflictCandidates: [
        {
          text: "third draft",
          attachments: [{ kind: "file", name: "third.txt", path: "/tmp/third.txt" }],
        },
      ],
    });
    const envelope = {
      intentId: "authority-owned-shell",
      expectedOwner: { hostInstanceId: "host-1", sessionEpoch: 0 },
      intent: shellIntent("read answer"),
    };
    const execute = vi.fn(() => ({ deferredOutcome: terminal.promise }));

    await expect(authority.dispatchIntent(envelope, execute)).resolves.toMatchObject({
      status: "admitted",
      intentId: "authority-owned-shell",
    });
    expect(acceptShellEditorSubmission).toHaveBeenCalledWith({
      intentId: "authority-owned-shell",
      editorRevision: 1,
      editorText: "!read answer",
      surface: undefined,
      deferClearEvidence: true,
    });
    expect(publishShellEditorSubmission).toHaveBeenCalledWith({
      intentId: "authority-owned-shell",
      editorRevision: 1,
      editorText: "!read answer",
      surface: undefined,
    });
    expect(authority.semanticSnapshot().editor).toMatchObject({
      revision: 2,
      text: "",
      attachments,
      conflictText: "newer draft",
      conflictAttachments: [{ kind: "file", name: "new.txt", path: "/tmp/new.txt" }],
      alternateConflictText: "alternate draft",
      additionalConflictCandidates: [
        {
          text: "third draft",
          attachments: [{ kind: "file", name: "third.txt", path: "/tmp/third.txt" }],
        },
      ],
    });

    // Model renderer disappearance: no renderer-originated clear patch occurs.
    // A fresh authority attach still receives the consumed editor and retained
    // staged context, while an intent retry remains exactly-once.
    const attached = await readyAttach(authority, 23);
    expect(attached.semantic.snapshot.editor).toMatchObject({
      revision: 2,
      text: "",
      attachments,
      conflictText: "newer draft",
    });
    await expect(authority.dispatchIntent(envelope, execute)).resolves.toMatchObject({
      status: "duplicate",
      intentId: "authority-owned-shell",
    });
    expect(execute).toHaveBeenCalledOnce();
    expect(acceptShellEditorSubmission).toHaveBeenCalledOnce();

    terminal.resolve({ output: "answer", exitCode: 0 });
    await flush();
  });

  it("fails closed before shell start when its exact editor source cannot be consumed", async () => {
    const acceptShellEditorSubmission = vi.fn(() => false);
    const { authority, setEditor } = setup({}, { acceptShellEditorSubmission });
    setEditor({ revision: 1, text: "!pwd", attachments: [] });
    const envelope = {
      intentId: "shell-custody-anomaly",
      expectedOwner: { hostInstanceId: "host-1", sessionEpoch: 0 },
      intent: shellIntent("pwd"),
    };
    const startShell = vi.fn(() => ({
      deferredOutcome: Promise.resolve({ output: "", exitCode: 0 }),
    }));
    const execute = vi.fn(() => ({
      shellPreparation: Promise.resolve({ command: "pwd" }),
      startShell,
    }));

    await expect(authority.dispatchIntent(envelope, execute)).resolves.toEqual({
      status: "not_admitted",
      intentId: "shell-custody-anomaly",
      reason: "stale_editor",
    });
    const attached = await readyAttach(authority, 24);
    expect(attached.semantic.snapshot.editor).toMatchObject({ revision: 1, text: "!pwd" });
    expect(attached.operationJournal).not.toContainEqual(
      expect.objectContaining({ type: "anomaly" }),
    );
    expect(execute).toHaveBeenCalledOnce();
    expect(startShell).not.toHaveBeenCalled();
  });

  it("rolls back a provisional native shell clear when durable start fails", async () => {
    const {
      authority,
      setEditor,
      acceptShellEditorSubmission,
      publishShellEditorSubmission,
      rollbackShellEditorSubmission,
    } = setup();
    setEditor({ revision: 1, text: "!pwd", attachments: [] });
    const envelope = {
      intentId: "shell-start-failure",
      expectedOwner: { hostInstanceId: "host-1", sessionEpoch: 0 },
      intent: shellIntent("pwd"),
    };
    const startShell = vi.fn(() => {
      throw new Error("PTY spawn failed");
    });
    const execute = vi.fn(() => ({
      shellPreparation: Promise.resolve({ command: "pwd" }),
      startShell,
    }));

    await expect(authority.dispatchIntent(envelope, execute)).resolves.toEqual({
      status: "not_admitted",
      intentId: "shell-start-failure",
      reason: "transport_unavailable",
    });
    expect(acceptShellEditorSubmission).toHaveBeenCalledWith({
      intentId: "shell-start-failure",
      editorRevision: 1,
      editorText: "!pwd",
      surface: undefined,
      deferClearEvidence: true,
    });
    expect(rollbackShellEditorSubmission).toHaveBeenCalledWith({
      intentId: "shell-start-failure",
      editorRevision: 1,
      editorText: "!pwd",
      surface: undefined,
    });
    expect(publishShellEditorSubmission).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledOnce();
    expect(startShell).toHaveBeenCalledWith({ command: "pwd" });
    expect(authority.semanticSnapshot().editor).toMatchObject({ revision: 1, text: "!pwd" });
    expect(authority.semanticSnapshot().activeIntents).toEqual([]);
  });

  it("reattaches a bounded active non-PTY Shell Turn with an ordered output baseline", async () => {
    const sendPresentation = vi.fn();
    const { authority, session } = setup({}, { sendPresentation });
    session.isBashRunning = true;
    authority.beginObservedOperation("bash");
    authority.observeEvent({
      type: "bash_execution_start",
      id: "non-pty-attach",
      command: "remote-build",
      excludeFromContext: true,
      pty: false,
      startedAt: 1_786_000_000_000,
      cwd: "/workspace/remote",
    });
    const newest = "n".repeat(1024 * 1024);
    authority.observeEvent({
      type: "bash_execution_update",
      id: "non-pty-attach",
      delta: `discarded-prefix${newest}`,
    });

    const attached = await readyAttach(authority, 25);
    expect(attached.transcript.currentShellTurn).toEqual({
      id: "non-pty-attach",
      command: "remote-build",
      owner: { hostInstanceId: "host-1", sessionEpoch: 0 },
      startedAt: 1_786_000_000_000,
      cwd: "/workspace/remote",
      excludeFromContext: true,
      pty: false,
      outputText: newest,
      outputThroughSequence: 1,
      replayTruncated: true,
    });
    expect(attached.semantic.snapshot.activity.bash).toMatchObject({
      intentId: "non-pty-attach",
      pty: false,
    });
    expect(AuthorityAttachBaselineSchema.safeParse(attached).success).toBe(true);
    expect(sendPresentation).toHaveBeenCalledWith(
      expect.objectContaining({
        plane: "transcript",
        payload: expect.objectContaining({
          entries: [
            expect.objectContaining({
              type: "bash_execution_update",
              id: "non-pty-attach",
              sequence: 1,
            }),
          ],
        }),
      }),
    );
  });

  it("refuses a foreground Shell Turn before admission while the session is busy", async () => {
    const { authority, session, setEditor, acceptShellEditorSubmission } = setup({
      isIdle: false,
      isStreaming: true,
    });
    setEditor({ revision: 1, text: "!pwd" });
    const execute = vi.fn();
    const envelope = {
      intentId: "busy-shell",
      expectedOwner: { hostInstanceId: "host-1", sessionEpoch: 0 },
      intent: shellIntent("pwd"),
    };

    await expect(authority.dispatchIntent(envelope, execute)).resolves.toEqual({
      status: "not_admitted",
      intentId: "busy-shell",
      reason: "busy",
    });
    expect(execute).not.toHaveBeenCalled();
    expect(acceptShellEditorSubmission).not.toHaveBeenCalled();
    expect(authority.semanticSnapshot().activeIntents).toEqual([]);

    session.isStreaming = false;
    session.isIdle = true;
    await expect(
      authority.dispatchIntent(envelope, () => ({
        deferredOutcome: Promise.resolve({ output: "", exitCode: 0 }),
      })),
    ).resolves.toMatchObject({ status: "admitted" });
  });

  it("revalidates the exact shell editor source in its serialized admission slot", async () => {
    const sendFrame = vi.fn();
    const { authority, setEditor, acceptShellEditorSubmission } = setup({}, { sendFrame });
    setEditor({ revision: 1, text: "!pwd" });
    const envelope = {
      intentId: "raced-shell-editor",
      expectedOwner: { hostInstanceId: "host-1", sessionEpoch: 0 },
      intent: shellIntent("pwd"),
    };
    const execute = vi.fn(() => ({
      deferredOutcome: Promise.resolve({ output: "/tmp", exitCode: 0 }),
    }));

    const receipt = authority.dispatchIntent(envelope, execute);
    // Same-owner typing can race the microtask-backed ingress scheduler. The
    // older command must never consume or execute against the newer revision.
    setEditor({ revision: 2, text: "!pwd --logical" });

    await expect(receipt).resolves.toEqual({
      status: "not_admitted",
      intentId: "raced-shell-editor",
      reason: "stale_editor",
    });
    await expect(authority.dispatchIntent(envelope, execute)).resolves.toEqual({
      status: "not_admitted",
      intentId: "raced-shell-editor",
      reason: "stale_editor",
    });
    expect(execute).not.toHaveBeenCalled();
    expect(acceptShellEditorSubmission).not.toHaveBeenCalled();
    expect(authority.semanticSnapshot().activeIntents).toEqual([]);
    expect(authority.failureEscrow().dispatchedIntents).toEqual([]);
    expect(sendFrame).not.toHaveBeenCalledWith(
      expect.objectContaining({
        records: expect.arrayContaining([expect.objectContaining({ type: "intent_admitted" })]),
      }),
    );
  });

  it("withholds Shell Turn admission until preparation succeeds and deduplicates while pending", async () => {
    const preparation = deferred();
    const terminal = deferred();
    const { authority, setEditor } = setup();
    setEditor({ revision: 1, text: "!!read answer" });
    const envelope = {
      intentId: "pending-shell-preparation",
      expectedOwner: { hostInstanceId: "host-1", sessionEpoch: 0 },
      intent: shellIntent("read answer", true),
    };
    const execute = vi.fn(async () => {
      await preparation.promise;
      return { deferredOutcome: terminal.promise };
    });

    const first = authority.dispatchIntent(envelope, execute);
    const duplicate = authority.dispatchIntent(envelope, execute);
    let firstSettled = false;
    void first.then(() => {
      firstSettled = true;
    });
    await flush();
    expect(firstSettled).toBe(false);
    expect(authority.semanticSnapshot().activeIntents).toEqual([]);

    const unrelated = vi.fn(() => ({
      deferredOutcome: Promise.resolve({ refreshed: true }),
    }));
    await expect(
      authority.dispatchIntent(
        {
          intentId: "unrelated-during-shell-preparation",
          expectedOwner: { hostInstanceId: "host-1", sessionEpoch: 0 },
          intent: { kind: "refreshModels" },
        },
        unrelated,
      ),
    ).resolves.toMatchObject({ status: "admitted" });
    await vi.waitFor(() => expect(unrelated).toHaveBeenCalledOnce());

    preparation.resolve();
    await expect(first).resolves.toMatchObject({ status: "admitted" });
    await expect(duplicate).resolves.toMatchObject({ status: "duplicate" });
    expect(execute).toHaveBeenCalledOnce();
    expect(authority.semanticSnapshot().activeIntents).toContainEqual(
      expect.objectContaining({ intentId: "pending-shell-preparation", state: "admitted" }),
    );
    terminal.resolve({ output: "ok", exitCode: 0 });
  });

  it("returns a truthful non-admission when Shell Turn preparation fails", async () => {
    const sendFrame = vi.fn();
    const { authority, setEditor, acceptShellEditorSubmission } = setup({}, { sendFrame });
    setEditor({ revision: 1, text: "!pwd" });
    const envelope = {
      intentId: "failed-shell-preparation",
      expectedOwner: { hostInstanceId: "host-1", sessionEpoch: 0 },
      intent: shellIntent("pwd"),
    };
    const execute = vi.fn(() => {
      throw new Error("PTY unavailable");
    });

    await expect(authority.dispatchIntent(envelope, execute)).resolves.toEqual({
      status: "not_admitted",
      intentId: "failed-shell-preparation",
      reason: "transport_unavailable",
    });
    await expect(authority.dispatchIntent(envelope, execute)).resolves.toEqual({
      status: "not_admitted",
      intentId: "failed-shell-preparation",
      reason: "transport_unavailable",
    });
    expect(execute).toHaveBeenCalledOnce();
    expect(authority.semanticSnapshot().activeIntents).toEqual([]);
    expect(authority.semanticSnapshot().recentIntentOutcomes).toEqual([]);
    expect(authority.failureEscrow().dispatchedIntents).toEqual([]);
    expect(authority.semanticSnapshot().editor).toMatchObject({
      revision: 1,
      text: "!pwd",
    });
    expect(acceptShellEditorSubmission).not.toHaveBeenCalled();
  });

  it("does not admit a Shell Turn while compatibility submission custody is unresolved", async () => {
    vi.useFakeTimers();
    try {
      const promptDone = deferred();
      const { authority, session, setEditor } = setup({
        isIdle: true,
        isStreaming: false,
        prompt: vi.fn(() => promptDone.promise),
      });
      setEditor({ revision: 1, text: "!pwd" });

      const pendingSubmission = authority.submit(makeRequest("held-submission"));
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(pendingSubmission).resolves.toMatchObject({ disposition: "admitting" });
      expect(authority.snapshot().hostFacts.submitting).toBe(true);

      // Pi's direct getters can still look idle while an input hook/preflight
      // owns submission custody. The child ledger must also fence Shell Turns.
      session.isIdle = true;
      session.isStreaming = false;
      await expect(
        authority.dispatchIntent(
          {
            intentId: "shell-during-custody",
            expectedOwner: { hostInstanceId: "host-1", sessionEpoch: 0 },
            intent: shellIntent("pwd"),
          },
          vi.fn(),
        ),
      ).resolves.toEqual({
        status: "not_admitted",
        intentId: "shell-during-custody",
        reason: "busy",
      });

      promptDone.resolve();
      await flush();
    } finally {
      vi.useRealTimers();
    }
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
    const successfulFrame = sendFrame.mock.calls
      .map(([frame]) => frame)
      .find((frame) =>
        frame.records.some(
          (record) =>
            record.type === "intent_outcome" && record.outcome.intentId === "navigate-success",
        ),
      );
    expect(
      successfulFrame.terminalSnapshot.recentIntentOutcomes.find(
        (outcome) => outcome.intentId === "navigate-success",
      ),
    ).toMatchObject({
      result: { targetId: "target-a", summarized: true, leafId: "leaf-a" },
    });
    expect(
      successfulFrame.terminalSnapshot.recentIntentOutcomes.find(
        (outcome) => outcome.intentId === "navigate-success",
      )?.result,
    ).not.toHaveProperty("branch");
    expect(
      successfulFrame.terminalSnapshot.recentIntentOutcomes.find(
        (outcome) => outcome.intentId === "navigate-success",
      )?.result,
    ).not.toHaveProperty("editorText");

    const attachedAfterNavigation = await readyAttach(authority, 1);
    const retainedNavigation = attachedAfterNavigation.operationJournal.find(
      (record) =>
        record.type === "intent_outcome" && record.outcome.intentId === "navigate-success",
    );
    expect(retainedNavigation?.outcome.result).not.toHaveProperty("branch");
    expect(attachedAfterNavigation.pendingNavigationPresentations).toEqual([
      {
        intentId: "navigate-success",
        owner,
        targetId: "target-a",
        summarized: true,
        leafId: "leaf-a",
        branch: [{ id: "root-a", type: "message", timestamp: 1 }],
      },
    ]);
    expect((await readyAttach(authority, 2)).pendingNavigationPresentations).toEqual(
      attachedAfterNavigation.pendingNavigationPresentations,
    );
    expect(
      authority.acknowledgeNavigationPresentation("navigate-success", {
        hostInstanceId: "host-1",
        sessionEpoch: 1,
      }),
    ).toBe(false);
    expect(authority.acknowledgeNavigationPresentation("other-intent", owner)).toBe(false);
    expect((await readyAttach(authority, 3)).pendingNavigationPresentations).toHaveLength(1);
    expect(authority.acknowledgeNavigationPresentation("navigate-success", owner)).toBe(true);
    // A lost response is safe to retry: the exact owner/intent tombstone is
    // idempotent, while unknown IDs above remain false.
    expect(authority.acknowledgeNavigationPresentation("navigate-success", owner)).toBe(true);
    expect((await readyAttach(authority, 4)).pendingNavigationPresentations).toEqual([]);

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
    expect((await readyAttach(authority, 5)).pendingNavigationPresentations).toEqual([]);
  });

  it("captures navigation presentation before drain and fences custody and later intents", async () => {
    const navigationGate = deferred();
    const { authority, session } = setup();
    const owner = { hostInstanceId: "host-1", sessionEpoch: 0 };
    const navigationEnvelope = {
      intentId: "navigate-before-drain",
      expectedOwner: owner,
      intent: { kind: "navigate", targetId: "leaf-after-navigation" },
    };

    await expect(
      authority.dispatchIntent(navigationEnvelope, (_intent, executionOwner) => ({
        deferredOutcome: authority.runNavigation(async () => {
          await navigationGate.promise;
          const evidence = {
            targetId: "leaf-after-navigation",
            leafId: "leaf-after-navigation",
            branch: [{ id: "leaf-after-navigation", type: "message", timestamp: 1 }],
          };
          authority.captureNavigationPresentation(
            navigationEnvelope.intentId,
            executionOwner,
            evidence,
          );
          return evidence;
        }),
      })),
    ).resolves.toMatchObject({ status: "admitted" });
    await vi.waitFor(() => expect(authority.snapshot().hostFacts.navigation).toBe(true));

    await expect(authority.submit(makeRequest("held-behind-navigation"))).resolves.toMatchObject({
      disposition: "in_custody",
    });
    navigationGate.resolve();
    await vi.waitFor(async () =>
      expect((await readyAttach(authority, 6)).pendingNavigationPresentations).toHaveLength(1),
    );
    expect(session.prompt).not.toHaveBeenCalled();

    // The exact retry remains a dedupe receipt, while a different mutation is
    // refused before it can enter the child ledger or call its executor.
    await expect(authority.dispatchIntent(navigationEnvelope, vi.fn())).resolves.toMatchObject({
      status: "duplicate",
    });
    const laterExecute = vi.fn();
    await expect(
      authority.dispatchIntent(
        {
          intentId: "later-thinking",
          expectedOwner: owner,
          intent: { kind: "setThinking", level: "high" },
        },
        laterExecute,
      ),
    ).resolves.toEqual({
      status: "not_admitted",
      intentId: "later-thinking",
      reason: "busy",
    });
    expect(laterExecute).not.toHaveBeenCalled();

    expect(authority.acknowledgeNavigationPresentation(navigationEnvelope.intentId, owner)).toBe(
      true,
    );
    await vi.waitFor(() => expect(session.prompt).toHaveBeenCalledTimes(1));
  });

  it("fences non-submit mutation dispatch from active navigation before presentation capture", async () => {
    const navigationGate = deferred();
    const { authority, session, setEditor } = setup();
    const owner = { hostInstanceId: "host-1", sessionEpoch: 0 };
    const navigationEnvelope = {
      intentId: "navigate-active-fence",
      expectedOwner: owner,
      intent: { kind: "navigate", targetId: "leaf-active-fence" },
    };

    await expect(
      authority.dispatchIntent(navigationEnvelope, () => ({
        deferredOutcome: authority.runNavigation(() => navigationGate.promise),
      })),
    ).resolves.toMatchObject({ status: "admitted" });
    await vi.waitFor(() => expect(authority.snapshot().hostFacts.navigation).toBe(true));

    // Exact retries remain deduplicated even while the original navigation is
    // active, but a distinct mutation is refused before ledger admission.
    await expect(authority.dispatchIntent(navigationEnvelope, vi.fn())).resolves.toMatchObject({
      status: "duplicate",
    });
    const mutationExecute = vi.fn();
    await expect(
      authority.dispatchIntent(
        {
          intentId: "thinking-during-active-navigation",
          expectedOwner: owner,
          intent: { kind: "setThinking", level: "high" },
        },
        mutationExecute,
      ),
    ).resolves.toEqual({
      status: "not_admitted",
      intentId: "thinking-during-active-navigation",
      reason: "busy",
    });
    expect(mutationExecute).not.toHaveBeenCalled();

    // Submit is the sole exception: its executor re-enters admit(), which
    // transfers the exact prompt into navigation custody without calling Pi.
    setEditor({ revision: 1, text: "held during active navigation", attachments: [] });
    await expect(
      authority.dispatchIntent(
        {
          intentId: "submit-during-active-navigation",
          expectedOwner: owner,
          intent: {
            kind: "submit",
            editorRevision: 1,
            text: "held during active navigation",
            images: [],
            requestedMode: "followUp",
            surface: "composer",
          },
        },
        (intent) =>
          authority.submit(
            {
              intentId: "submit-during-active-navigation",
              expectedHostId: owner.hostInstanceId,
              expectedEpoch: owner.sessionEpoch,
              ...intent,
            },
            true,
          ),
      ),
    ).resolves.toMatchObject({ status: "admitted" });
    await vi.waitFor(() => expect(authority.snapshot().hostFacts.custodyCount).toBe(1));
    expect(session.prompt).not.toHaveBeenCalled();

    navigationGate.resolve({ targetId: "leaf-active-fence", cancelled: true });
    await vi.waitFor(() => expect(authority.snapshot().hostFacts.navigation).toBe(false));
  });

  it("rechecks queued mutation execution after navigation captures presentation custody", async () => {
    const { authority } = setup();
    const owner = { hostInstanceId: "host-1", sessionEpoch: 0 };
    const navigationEnvelope = {
      intentId: "navigate-before-queued-executor",
      expectedOwner: owner,
      intent: { kind: "navigate", targetId: "leaf-before-queued-executor" },
    };
    const queuedExecute = vi.fn(() => ({ level: "high" }));

    // Reserve both receipts in one turn, before the scheduler opens
    // runNavigation. The second receipt is therefore admitted, but its
    // serialized executor must recheck the barrier established by the first.
    const navigationReceipt = authority.dispatchIntent(
      navigationEnvelope,
      (_intent, executionOwner) => ({
        deferredOutcome: authority.runNavigation(async () => {
          const evidence = {
            targetId: "leaf-before-queued-executor",
            leafId: "leaf-before-queued-executor",
            branch: [{ id: "leaf-before-queued-executor", type: "message", timestamp: 1 }],
          };
          authority.captureNavigationPresentation(
            navigationEnvelope.intentId,
            executionOwner,
            evidence,
          );
          return evidence;
        }),
      }),
    );
    const queuedReceipt = authority.dispatchIntent(
      {
        intentId: "queued-behind-navigation",
        expectedOwner: owner,
        intent: { kind: "setThinking", level: "high" },
      },
      queuedExecute,
    );

    await expect(navigationReceipt).resolves.toMatchObject({ status: "admitted" });
    await expect(queuedReceipt).resolves.toMatchObject({ status: "admitted" });
    await vi.waitFor(() =>
      expect(
        authority
          .createSemanticFrame()
          .terminalSnapshot.recentIntentOutcomes.find(
            (outcome) => outcome.intentId === "queued-behind-navigation",
          ),
      ).toMatchObject({
        kind: "setThinking",
        state: "rejected",
        error: "Navigation is active or awaiting presentation acknowledgement",
      }),
    );
    expect(queuedExecute).not.toHaveBeenCalled();
    expect((await readyAttach(authority, 7)).pendingNavigationPresentations).toHaveLength(1);
    expect(authority.acknowledgeNavigationPresentation(navigationEnvelope.intentId, owner)).toBe(
      true,
    );
  });

  it("retains compact navigation outcomes while tiny-capacity submit custody is pending", async () => {
    const { authority, session, setEditor } = setup({}, { dispatchedIntentCapacity: 2 });
    const owner = { hostInstanceId: "host-1", sessionEpoch: 0 };
    const navigationIntentId = "navigate-capacity-escrow";

    await authority.dispatchIntent(
      {
        intentId: navigationIntentId,
        expectedOwner: owner,
        intent: { kind: "navigate", targetId: "leaf-capacity-escrow" },
      },
      async () => ({
        targetId: "leaf-capacity-escrow",
        leafId: "leaf-capacity-escrow",
        branch: [{ id: "leaf-capacity-escrow", type: "message", timestamp: 1 }],
      }),
    );
    await vi.waitFor(async () =>
      expect((await readyAttach(authority, 8)).pendingNavigationPresentations).toHaveLength(1),
    );

    const dispatchSubmit = (intentId) =>
      authority.dispatchIntent(
        {
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
        },
        (intent) =>
          authority.submit(
            {
              intentId,
              expectedHostId: owner.hostInstanceId,
              expectedEpoch: owner.sessionEpoch,
              ...intent,
            },
            true,
          ),
      );

    setEditor({ revision: 1, text: "capacity-custody-one", attachments: [] });
    await expect(dispatchSubmit("capacity-custody-one")).resolves.toMatchObject({
      status: "admitted",
    });
    await vi.waitFor(() => expect(authority.snapshot().hostFacts.custodyCount).toBe(1));
    expect(session.prompt).not.toHaveBeenCalled();

    // The navigation terminal fact is not available for capacity eviction:
    // rejecting later ingress is safer than orphaning its full branch escrow.
    setEditor({ revision: 1, text: "capacity-custody-two", attachments: [] });
    await expect(dispatchSubmit("capacity-custody-two")).resolves.toEqual({
      status: "not_admitted",
      intentId: "capacity-custody-two",
      reason: "invalid",
      invalidReason: "capacity",
    });
    const attach = await readyAttach(authority, 9);
    expect(attach.pendingNavigationPresentations).toMatchObject([
      { intentId: navigationIntentId, owner },
    ]);
    expect(
      attach.semantic.snapshot.recentIntentOutcomes.find(
        (outcome) => outcome.intentId === navigationIntentId,
      ),
    ).toMatchObject({
      kind: "navigate",
      state: "completed",
      result: {
        targetId: "leaf-capacity-escrow",
        leafId: "leaf-capacity-escrow",
      },
    });
    expect(AuthorityAttachBaselineSchema.safeParse(attach).success).toBe(true);

    expect(authority.acknowledgeNavigationPresentation(navigationIntentId, owner)).toBe(true);
    await vi.waitFor(() => expect(session.prompt).toHaveBeenCalledTimes(1));
  });

  it("does not repeat a large navigation branch in later semantic frames", async () => {
    const sendFrame = vi.fn();
    const { authority } = setup({}, { sendFrame });
    const owner = { hostInstanceId: "host-1", sessionEpoch: 0 };
    const branch = [
      {
        id: "large-leaf",
        type: "message",
        timestamp: 1,
        message: { role: "toolResult", content: "x".repeat(1024 * 1024) },
      },
    ];

    await authority.dispatchIntent(
      {
        intentId: "navigate-large",
        expectedOwner: owner,
        intent: { kind: "navigate", targetId: "large-leaf" },
      },
      async () => ({ targetId: "large-leaf", leafId: "large-leaf", branch }),
    );
    await vi.waitFor(() =>
      expect(
        sendFrame.mock.calls.some(([frame]) =>
          frame.records.some(
            (record) =>
              record.type === "intent_outcome" && record.outcome.intentId === "navigate-large",
          ),
        ),
      ).toBe(true),
    );

    const liveOutcomeFrame = sendFrame.mock.calls
      .map(([frame]) => frame)
      .find((frame) =>
        frame.records.some(
          (record) =>
            record.type === "intent_outcome" && record.outcome.intentId === "navigate-large",
        ),
      );
    expect(Buffer.byteLength(JSON.stringify(liveOutcomeFrame))).toBeGreaterThan(1024 * 1024);

    const laterFrame = authority.createSemanticFrame();
    expect(Buffer.byteLength(JSON.stringify(laterFrame))).toBeLessThan(64 * 1024);
    expect(
      laterFrame.terminalSnapshot.recentIntentOutcomes.find(
        (outcome) => outcome.intentId === "navigate-large",
      )?.result,
    ).toEqual({ targetId: "large-leaf", leafId: "large-leaf" });
  });

  it("settles admitted idle and queued submit intents exactly once with typed public evidence", async () => {
    const idleGate = deferred();
    const sendFrame = vi.fn();
    const { authority, session, setEditor } = setup(
      {
        prompt: vi.fn((_text, options) => {
          options.preflightResult("started");
          session.isStreaming = true;
          return idleGate.promise;
        }),
      },
      { sendFrame },
    );
    const owner = { hostInstanceId: "host-1", sessionEpoch: 0 };
    const envelope = (intentId, editorRevision = 1) => ({
      intentId,
      expectedOwner: owner,
      intent: {
        kind: "submit",
        editorRevision,
        text: intentId,
        images: [],
        requestedMode: "followUp",
        surface: "composer",
      },
    });

    setEditor({ revision: 1, text: "idle-complete", attachments: [] });
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
      options.preflightResult("queued");
      return queuedGate.promise;
    });
    setEditor({ revision: 1, text: "queued-complete", attachments: [] });
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
        prompt: vi.fn(() => Promise.reject(new Error("extension exploded"))),
      },
      {
        sendFrame,
        getEditor: () => ({ revision: 1, text: "/explode", attachments: [] }),
      },
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
            inputKind: "slash_command",
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

  it("normalizes command, model, bash, and trust outcomes without leaking raw SDK values", async () => {
    const sendFrame = vi.fn();
    const { authority, setEditor } = setup({}, { sendFrame });
    setEditor({ revision: 1, text: "!pwd" });
    const owner = { hostInstanceId: "host-1", sessionEpoch: 0 };
    const dispatch = (intentId, intent, execute) =>
      authority.dispatchIntent({ intentId, expectedOwner: owner, intent }, execute);

    await dispatch("bash-result", shellIntent("pwd"), async () => ({
      deferredOutcome: Promise.resolve({
        output: "/tmp",
        exitCode: 0,
        cancelled: false,
      }),
    }));
    await dispatch(
      "trust-result",
      { kind: "setTrust", optionLabel: "Trust this folder" },
      async () => ({ trusted: true, persisted: true, updates: [{ private: "ignored" }] }),
    );
    await dispatch(
      "model-result",
      { kind: "setModel", provider: "anthropic", modelId: "claude" },
      async () => ({ model: { private: "ignored" } }),
    );
    setEditor({ revision: 2, text: "/test", attachments: [] });
    await dispatch(
      "command-result",
      { kind: "invokeCommand", text: "/test", editorRevision: 2 },
      async () => ({ disposition: "rejected", editorRevision: 2, message: "blocked" }),
    );

    await vi.waitFor(() =>
      expect(
        sendFrame.mock.calls
          .flatMap(([frame]) => frame.records)
          .filter((record) => record.type === "intent_outcome"),
      ).toHaveLength(4),
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
        intentId: "trust-result",
        result: { trusted: true, persisted: true },
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
          editorRevision: 2,
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
    const { authority, setEditor } = setup(
      {},
      { dispatchedIntentCapacity: 2, dispatchedIntentPayloadBytes: 200 },
    );
    const owner = { hostInstanceId: "host-1", sessionEpoch: 0 };
    const dispatch = (intentId, editorRevision) =>
      authority.dispatchIntent(
        { intentId, expectedOwner: owner, intent: shellIntent("pwd", false, editorRevision) },
        async () => ({
          deferredOutcome: Promise.resolve({ output: "/tmp", exitCode: 0 }),
        }),
      );

    for (const [index, id] of ["one", "two", "three"].entries()) {
      const editorRevision = index + 1;
      setEditor({ revision: editorRevision, text: "!pwd" });
      await expect(dispatch(id, editorRevision)).resolves.toMatchObject({
        status: "admitted",
      });
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
    navigation.resolve();
    await navigating;
    await authority.dispatchIntent(
      {
        intentId: "outcome-intent",
        expectedOwner: owner,
        intent: { kind: "setThinking", level: "low" },
      },
      async () => ({ level: "low" }),
    );
    await vi.waitFor(() =>
      expect(authority.createSemanticFrame().terminalSnapshot.recentIntentOutcomes).toContainEqual(
        expect.objectContaining({ intentId: "outcome-intent", state: "completed" }),
      ),
    );
    authority.settleObservedOperation("bash", bashId, { intentId: "bash-intent" });
    authority.settleCompactionInvocation("compact-intent");

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
      { kind: "pickerAction", selection: { action: "fork", entryId: "entry-a" } },
      {
        kind: "pickerAction",
        selection: { action: "fork", entryId: "entry-a" },
        surface: "detached",
      },
      {
        kind: "pickerAction",
        selection: { action: "fork", entryId: "", text: "/new" },
        surface: "composer",
      },
      {
        kind: "pickerAction",
        selection: { action: "setScopedModels", enabledIds: [""], persist: false },
        surface: "composer",
      },
      {
        kind: "pickerAction",
        selection: { action: "logoutProvider", providerId: "", extra: 1 },
        surface: "composer",
      },
      {
        kind: "pickerAction",
        selection: { action: "arbitrary", text: "/new" },
        surface: "composer",
      },
      { ...shellIntent("pwd"), excludeFromContext: "no" },
      { ...shellIntent("pwd"), editorRevision: -1 },
      { ...shellIntent("pwd"), editorText: "pwd" },
      { ...shellIntent("pwd"), editorText: "!!pwd" },
      { ...shellIntent("pwd"), command: "other" },
      { ...shellIntent("pwd"), command: "" },
      { ...shellIntent("pwd"), command: " \n\t " },
      { ...shellIntent("pwd"), command: " pwd" },
      { kind: "setTrust", optionLabel: "", updates: [] },
      { kind: "navigate", targetId: "", summarize: "yes" },
      { kind: "setModel", provider: "p", modelId: "" },
      { kind: "setThinking", level: "turbo" },
      { kind: "rename", name: 1 },
      { kind: "reload", extra: true },
      { kind: "reload", editorRevision: 1 },
      { kind: "reload", editorText: "/reload" },
      { kind: "reload", surface: "unified" },
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

  it("reports the UTF-8 shell command limit as payload_too_large at the hostile child boundary", async () => {
    const { authority } = setup();
    const owner = { hostInstanceId: "host-1", sessionEpoch: 0 };
    const execute = vi.fn();
    const command = "é".repeat(32_769);

    await expect(
      authority.dispatchIntent(
        {
          intentId: "oversized-shell",
          expectedOwner: owner,
          intent: shellIntent(command),
        },
        execute,
      ),
    ).resolves.toEqual({
      status: "not_admitted",
      intentId: "oversized-shell",
      reason: "invalid",
      invalidReason: "payload_too_large",
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("accepts a shell command at exactly 64 KiB UTF-8", async () => {
    const { authority, setEditor } = setup();
    const command = "é".repeat(32_768);
    setEditor({ revision: 1, text: `!${command}` });

    await expect(
      authority.dispatchIntent(
        {
          intentId: "max-sized-shell",
          expectedOwner: { hostInstanceId: "host-1", sessionEpoch: 0 },
          intent: shellIntent(command),
        },
        () => ({
          deferredOutcome: Promise.resolve({ output: "", exitCode: 0 }),
        }),
      ),
    ).resolves.toMatchObject({ status: "admitted" });
  });

  it("keeps token deltas linear and suppresses unchanged semantic frames", async () => {
    const sendFrame = vi.fn();
    const sendPresentation = vi.fn();
    const { authority } = setup(
      { isStreaming: true, isIdle: false },
      { sendFrame, sendPresentation },
    );
    authority.publishSnapshot();
    sendFrame.mockClear();
    sendPresentation.mockClear();

    const cumulativeMessage = {
      role: "assistant",
      content: [{ type: "text", text: "x".repeat(64 * 1024) }],
      provider: "test-provider",
      model: "test-model",
    };
    authority.observeEvent({
      type: "message_update",
      message: cumulativeMessage,
      assistantMessageEvent: {
        type: "text_delta",
        delta: "x",
        contentIndex: 0,
        partial: cumulativeMessage,
      },
    });

    expect(sendFrame).not.toHaveBeenCalled();
    expect(sendPresentation).toHaveBeenCalledOnce();
    const publication = sendPresentation.mock.calls[0][0];
    expect(publication.payload.entries).toEqual([
      {
        type: "message_update",
        message: { role: "assistant" },
        assistantMessageEvent: { type: "text_delta", delta: "x", contentIndex: 0 },
      },
    ]);
    expect(JSON.stringify(publication).length).toBeLessThan(1_000);

    const attached = await readyAttach(authority, 31);
    expect(attached.transcript.currentStreamingMessage).toEqual(cumulativeMessage);
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
