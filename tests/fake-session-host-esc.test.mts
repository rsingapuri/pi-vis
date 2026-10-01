import { type ChildProcess, fork } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AuthorityAttachBaselineSchema,
  AuthorityFrameSchema,
  AuthorityPresentationPublicationSchema,
} from "../src/shared/pi-protocol/runtime-state.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/fake-session-host.mjs", import.meta.url));

interface WireMessage {
  type?: string;
  id?: string;
  success?: boolean;
  data?: Record<string, unknown>;
  payload?: { type?: string; snapshot?: Record<string, unknown> };
  [key: string]: unknown;
}

function waitUntil<T>(read: () => T | undefined, timeoutMs = 3_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const check = () => {
      const value = read();
      if (value !== undefined) return resolve(value);
      if (Date.now() - started >= timeoutMs)
        return reject(new Error("Timed out waiting for fixture"));
      setTimeout(check, 5);
    };
    check();
  });
}

describe("fake session host ESC process semantics", () => {
  let child: ChildProcess;
  let tempDir: string;
  let operationLog: string;
  let messages: WireMessage[];
  let requestSequence: number;

  const send = (message: Record<string, unknown>) => child.send?.(message);
  const response = (id: string) =>
    waitUntil(() => messages.find((message) => message.type === "response" && message.id === id));
  const logs = (): Array<Record<string, unknown>> => {
    if (!fs.existsSync(operationLog)) return [];
    return fs
      .readFileSync(operationLog, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  };
  const waitForLog = (event: string, kind?: string) =>
    waitUntil(() =>
      logs().find((entry) => entry.event === event && (!kind || entry.kind === kind)),
    );
  const latestSnapshot = () =>
    [...messages]
      .reverse()
      .find((message) => message.type === "control" && message.payload?.type === "snapshot")
      ?.payload?.snapshot;
  const submit = async (text: string, requestedMode = "followUp", images: unknown[] = []) => {
    const snapshot = latestSnapshot();
    if (!snapshot) throw new Error("Missing runtime snapshot");
    const id = `submit-${++requestSequence}`;
    send({
      type: "submit",
      id,
      submission: {
        intentId: `intent-${requestSequence}`,
        expectedHostId: snapshot.hostInstanceId,
        expectedEpoch: snapshot.sessionEpoch,
        editorRevision: (snapshot.editor as { revision: number }).revision,
        text,
        images,
        requestedMode,
        surface: "composer",
      },
    });
    await response(id);
    return id;
  };
  const requestEscape = async () => {
    const id = `escape-${++requestSequence}`;
    send({ type: "escape", id, requestId: `request-${requestSequence}` });
    const result = await response(id);
    return result.data as { disposition: string; target?: string; restorationId?: string };
  };
  const command = (type: string, extra: Record<string, unknown> = {}) => {
    const id = `command-${++requestSequence}`;
    send({ type: "command", id, command: { type, ...extra } });
    return id;
  };

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pivis-fake-esc-unit-"));
    operationLog = path.join(tempDir, "operations.jsonl");
    messages = [];
    requestSequence = 0;
    child = fork(FIXTURE, [], {
      cwd: tempDir,
      env: {
        ...process.env,
        PIVIS_TEST_HOST_OPERATION_LOG: operationLog,
        PIVIS_SESSIONS_DIR: path.join(tempDir, "sessions"),
      },
      stdio: ["ignore", "ignore", "pipe", "ipc"],
      serialization: "advanced",
    });
    child.on("message", (message) => messages.push(message as WireMessage));
    send({ type: "init", cwd: tempDir });
    await waitUntil(() =>
      messages.find((message) => message.type === "control" && message.payload?.type === "ready"),
    );
    // The ready snapshot is nested directly on the ready payload, while later
    // snapshots use payload.snapshot. Ask for one uniform full snapshot.
    const id = "initial-state";
    send({ type: "state_request", id });
    await response(id);
  });

  afterEach(() => {
    child.kill("SIGKILL");
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it.each([
    ["/test-navigation", "navigation"],
    ["/test-retry", "retry"],
    ["hello cancellable stream [test:hold-streaming]", "streaming"],
  ])("cancels %s as %s without late completion", async (text, target) => {
    await submit(text);
    const started = await waitForLog("started", target);
    await expect(requestEscape()).resolves.toMatchObject({
      disposition: "abort_requested",
      target,
    });
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(
      logs().some(
        (entry) =>
          entry.event === "completed" && entry.kind === target && entry.token === started.token,
      ),
    ).toBe(false);
    expect(
      logs().some(
        (entry) =>
          entry.event === "persisted" && entry.kind === target && entry.token === started.token,
      ),
    ).toBe(false);
  });

  it("publishes schema-valid authority baselines, frames, and independent presentation cursors", async () => {
    send({ type: "authority_attach", id: "authority-attach", rendererGeneration: 7 });
    const attached = await response("authority-attach");
    expect(attached.data).toMatchObject({ status: "ready" });
    const baseline = AuthorityAttachBaselineSchema.parse(
      (attached.data as { baseline: unknown }).baseline,
    );
    expect(baseline.rendererGeneration).toBe(7);
    expect(baseline.semantic.snapshot.availableThinkingLevels).toEqual(["off"]);

    send({
      type: "dispatch_intent",
      id: "authority-model",
      envelope: {
        intentId: "authority-model-intent",
        expectedOwner: baseline.owner,
        intent: { kind: "setModel", provider: "fake", modelId: "fake-model-2" },
      },
    });
    await expect(response("authority-model")).resolves.toMatchObject({
      data: { status: "admitted", intentId: "authority-model-intent" },
    });
    const modelTerminal = await waitUntil(() =>
      messages.find(
        (message) =>
          message.type === "authority_frame" &&
          (
            message.frame as { records?: Array<{ type?: string; outcome?: { intentId?: string } }> }
          )?.records?.some(
            (record) =>
              record.type === "intent_outcome" &&
              record.outcome?.intentId === "authority-model-intent",
          ),
      ),
    );
    const modelFrame = AuthorityFrameSchema.parse(modelTerminal.frame);
    expect(modelFrame.terminalSnapshot.model?.id).toBe("fake-model-2");
    expect(modelFrame.terminalSnapshot.availableThinkingLevels).toEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
    ]);

    send({
      type: "dispatch_intent",
      id: "authority-thinking",
      envelope: {
        intentId: "authority-thinking-intent",
        expectedOwner: baseline.owner,
        intent: { kind: "setThinking", level: "low" },
      },
    });
    await expect(response("authority-thinking")).resolves.toMatchObject({
      data: { status: "admitted", intentId: "authority-thinking-intent" },
    });
    const terminal = await waitUntil(() =>
      messages.find(
        (message) =>
          message.type === "authority_frame" &&
          (
            message.frame as { records?: Array<{ type?: string; outcome?: { intentId?: string } }> }
          )?.records?.some(
            (record) =>
              record.type === "intent_outcome" &&
              record.outcome?.intentId === "authority-thinking-intent",
          ),
      ),
    );
    const frame = AuthorityFrameSchema.parse(terminal.frame);
    expect(frame.terminalSnapshot.owner).toEqual(baseline.owner);

    const transcript = await waitUntil(() =>
      messages.find(
        (message) =>
          message.type === "authority_publication" &&
          (message.publication as { plane?: string })?.plane === "transcript",
      ),
    );
    const publication = AuthorityPresentationPublicationSchema.parse(transcript.publication);
    expect(publication.plane).toBe("transcript");
    if (publication.plane === "transcript") {
      expect(publication.payload.cursor.transportSequence).toBeGreaterThan(0);
    }
  });

  it("compares and consumes an exact editor source with causal evidence and attachment custody", async () => {
    const initial = latestSnapshot();
    if (!initial) throw new Error("Missing runtime snapshot");
    const initialEditor = initial.editor as { revision: number };
    const sourceRevision = initialEditor.revision + 1;
    const attachments = [{ kind: "file", name: "context.txt", path: "/tmp/context.txt" }];

    send({
      type: "editor_patch",
      id: "consume-source-editor",
      patch: {
        baseRevision: initialEditor.revision,
        revision: sourceRevision,
        text: "/model",
        attachments,
      },
    });
    await expect(response("consume-source-editor")).resolves.toMatchObject({
      data: { accepted: true, revision: sourceRevision, text: "/model", attachments },
    });

    send({
      type: "consume_editor_source",
      id: "consume-exact",
      request: {
        intentId: "consume-exact-intent",
        editorRevision: sourceRevision,
        editorText: "/model",
      },
    });
    const consumed = await response("consume-exact");
    expect(consumed).toMatchObject({
      data: {
        accepted: true,
        sourceRevision,
        editor: { revision: sourceRevision + 1, text: "", attachments },
      },
    });
    const clearEvidence = await waitUntil(() =>
      messages.find(
        (message) =>
          message.type === "editor_source_cleared" && message.intentId === "consume-exact-intent",
      ),
    );
    expect(clearEvidence).toMatchObject({
      editorRevision: sourceRevision,
      editor: { revision: sourceRevision + 1, text: "", attachments },
    });
    expect(messages.indexOf(clearEvidence)).toBeLessThan(messages.indexOf(consumed));

    send({
      type: "consume_editor_source",
      id: "consume-stale",
      request: {
        intentId: "consume-stale-intent",
        editorRevision: sourceRevision,
        editorText: "/model",
        consumeAttachments: true,
      },
    });
    await expect(response("consume-stale")).resolves.toMatchObject({
      data: {
        accepted: false,
        editor: { revision: sourceRevision + 1, text: "", attachments },
      },
    });
    expect(
      messages.some(
        (message) =>
          message.type === "editor_source_cleared" && message.intentId === "consume-stale-intent",
      ),
    ).toBe(false);

    send({
      type: "editor_patch",
      id: "consume-attachments-editor",
      patch: {
        baseRevision: sourceRevision + 1,
        revision: sourceRevision + 2,
        text: "/login",
        attachments,
      },
    });
    await response("consume-attachments-editor");
    send({
      type: "consume_editor_source",
      id: "consume-attachments",
      request: {
        intentId: "consume-attachments-intent",
        editorRevision: sourceRevision + 2,
        editorText: "/login",
        consumeAttachments: true,
      },
    });
    await expect(response("consume-attachments")).resolves.toMatchObject({
      data: {
        accepted: true,
        sourceRevision: sourceRevision + 2,
        editor: { revision: sourceRevision + 3, text: "", attachments: [] },
      },
    });
  });

  it("preclaims /new before admission and carries an empty editor into its successor", async () => {
    const initial = latestSnapshot();
    if (!initial) throw new Error("Missing runtime snapshot");
    const owner = {
      hostInstanceId: String(initial.hostInstanceId),
      sessionEpoch: Number(initial.sessionEpoch),
    };
    const initialEditor = initial.editor as { revision: number };
    const sourceRevision = initialEditor.revision + 1;
    const attachments = [{ kind: "file", name: "context.txt", path: "/tmp/context.txt" }];

    send({
      type: "editor_patch",
      id: "new-source-editor",
      patch: {
        baseRevision: initialEditor.revision,
        revision: sourceRevision,
        text: "/new",
        attachments,
      },
    });
    await response("new-source-editor");
    send({
      type: "dispatch_intent",
      id: "dispatch-new",
      envelope: {
        intentId: "new-intent",
        expectedOwner: owner,
        intent: {
          kind: "invokeCommand",
          text: "/new",
          editorRevision: sourceRevision,
          surface: "composer",
        },
      },
    });

    const admitted = await response("dispatch-new");
    expect(admitted).toMatchObject({
      data: { status: "admitted", intentId: "new-intent", owner },
    });
    const clearEvidence = await waitUntil(() =>
      messages.find(
        (message) => message.type === "editor_source_cleared" && message.intentId === "new-intent",
      ),
    );
    expect(clearEvidence).toMatchObject({
      editorRevision: sourceRevision,
      editor: { revision: sourceRevision + 1, text: "", attachments },
    });
    expect(messages.indexOf(clearEvidence)).toBeLessThan(messages.indexOf(admitted));

    const prepare = await waitUntil(() =>
      messages.find((message) => message.type === "transition_prepare"),
    );
    expect(messages.indexOf(clearEvidence)).toBeLessThan(messages.indexOf(prepare));
    send({
      type: "transition_permit",
      transitionId: prepare.transitionId,
      allowed: true,
    });
    const transitioned = await waitUntil(() =>
      messages.find(
        (message) => message.type === "control" && message.payload?.type === "transition_batch",
      ),
    );
    expect(
      (
        transitioned.payload as {
          batch?: { terminalSnapshot?: { editor?: unknown } };
        }
      ).batch?.terminalSnapshot?.editor,
    ).toEqual({ revision: sourceRevision + 1, text: "", attachments });
  });

  it("deduplicates an admitted invoke command before source checks and rejects conflicts and stale sources", async () => {
    const initial = latestSnapshot();
    if (!initial) throw new Error("Missing runtime snapshot");
    const owner = {
      hostInstanceId: String(initial.hostInstanceId),
      sessionEpoch: Number(initial.sessionEpoch),
    };
    const initialEditor = initial.editor as { revision: number };
    const sourceRevision = initialEditor.revision + 1;
    const envelope = {
      intentId: "invoke-once-intent",
      expectedOwner: owner,
      intent: {
        kind: "invokeCommand",
        text: "/widget-on",
        editorRevision: sourceRevision,
        surface: "composer",
      },
    };

    send({
      type: "editor_patch",
      id: "invoke-once-editor",
      patch: {
        baseRevision: initialEditor.revision,
        revision: sourceRevision,
        text: "/widget-on",
        attachments: [],
      },
    });
    await response("invoke-once-editor");

    send({ type: "dispatch_intent", id: "invoke-once-first", envelope });
    await expect(response("invoke-once-first")).resolves.toMatchObject({
      data: { status: "admitted", intentId: "invoke-once-intent", owner },
    });
    send({ type: "dispatch_intent", id: "invoke-once-duplicate", envelope });
    await expect(response("invoke-once-duplicate")).resolves.toMatchObject({
      data: { status: "duplicate", intentId: "invoke-once-intent", owner },
    });
    send({
      type: "dispatch_intent",
      id: "invoke-once-conflict",
      envelope: {
        ...envelope,
        intent: { ...envelope.intent, text: "/widget-off" },
      },
    });
    await expect(response("invoke-once-conflict")).resolves.toMatchObject({
      data: {
        status: "not_admitted",
        intentId: "invoke-once-intent",
        reason: "invalid",
        invalidReason: "payload_conflict",
      },
    });
    send({
      type: "dispatch_intent",
      id: "invoke-once-stale",
      envelope: { ...envelope, intentId: "invoke-stale-intent" },
    });
    await expect(response("invoke-once-stale")).resolves.toMatchObject({
      data: { status: "not_admitted", intentId: "invoke-stale-intent", reason: "stale_editor" },
    });

    await waitUntil(() =>
      messages.find(
        (message) =>
          message.type === "authority_frame" &&
          (
            message.frame as { records?: Array<{ type?: string; outcome?: { intentId?: string } }> }
          )?.records?.some((record) => record.outcome?.intentId === "invoke-once-intent"),
      ),
    );
    send({ type: "command", id: "invoke-once-state", command: { type: "get_state" } });
    await expect(response("invoke-once-state")).resolves.toMatchObject({
      data: { messageCount: 1 },
    });
    expect(
      messages.filter(
        (message) =>
          message.type === "editor_source_cleared" && message.intentId === "invoke-once-intent",
      ),
    ).toHaveLength(1);
  });

  it("admits an active Shell Turn only after consuming its exact draft and preserving attachments", async () => {
    const initial = latestSnapshot();
    if (!initial) throw new Error("Missing runtime snapshot");
    const owner = {
      hostInstanceId: String(initial.hostInstanceId),
      sessionEpoch: Number(initial.sessionEpoch),
    };
    const initialEditor = initial.editor as { revision: number };
    const shellRevision = initialEditor.revision + 1;
    const shellText = "!!test-interactive-shell";
    const attachments = [{ kind: "file", name: "context.txt", path: "/tmp/context.txt" }];

    send({
      type: "editor_patch",
      id: "shell-editor",
      patch: {
        baseRevision: initialEditor.revision,
        revision: shellRevision,
        text: shellText,
        attachments,
      },
    });
    await expect(response("shell-editor")).resolves.toMatchObject({
      data: { accepted: true, revision: shellRevision, text: shellText, attachments },
    });

    send({
      type: "dispatch_intent",
      id: "stale-shell",
      envelope: {
        intentId: "stale-shell-intent",
        expectedOwner: owner,
        intent: {
          kind: "runBash",
          command: "test-interactive-shell",
          excludeFromContext: true,
          editorRevision: shellRevision - 1,
          editorText: shellText,
        },
      },
    });
    await expect(response("stale-shell")).resolves.toMatchObject({
      data: {
        status: "not_admitted",
        intentId: "stale-shell-intent",
        reason: "stale_editor",
      },
    });
    expect(logs().some((entry) => entry.event === "started" && entry.kind === "bash")).toBe(false);

    send({
      type: "dispatch_intent",
      id: "active-shell",
      envelope: {
        intentId: "active-shell-intent",
        expectedOwner: owner,
        intent: {
          kind: "runBash",
          command: "test-interactive-shell",
          excludeFromContext: true,
          editorRevision: shellRevision,
          editorText: shellText,
        },
      },
    });
    const admitted = await response("active-shell");
    expect(admitted).toMatchObject({
      data: {
        status: "admitted",
        intentId: "active-shell-intent",
        owner,
      },
    });
    const active = await waitUntil(() =>
      messages.find(
        (message) =>
          message.type === "authority_frame" &&
          (
            message.frame as {
              terminalSnapshot?: { activity?: { bash?: { intentId?: string } } };
            }
          )?.terminalSnapshot?.activity?.bash?.intentId === "active-shell-intent",
      ),
    );
    const frame = AuthorityFrameSchema.parse(active.frame);
    expect(frame.terminalSnapshot.activity.bash).toMatchObject({
      kind: "bash",
      state: "active",
      intentId: "active-shell-intent",
      command: "test-interactive-shell",
      excludeFromContext: true,
      pty: true,
      inputReady: true,
      terminalMode: "compact",
    });
    expect(frame.terminalSnapshot.editor).toEqual({
      revision: shellRevision + 1,
      text: "",
      attachments,
    });
    expect(frame.terminalSnapshot.activeIntents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          intentId: "active-shell-intent",
          kind: "runBash",
          state: "admitted",
        }),
      ]),
    );
    expect(messages.indexOf(active)).toBeLessThan(messages.indexOf(admitted));

    send({ type: "authority_attach", id: "shell-reattach", rendererGeneration: 9 });
    const reattached = await response("shell-reattach");
    const currentShellTurn = (
      reattached.data as {
        baseline?: {
          transcript?: {
            currentShellTurn?: {
              reconstructionFenceToken: number;
              outputThroughSequence: number;
            };
          };
        };
      }
    ).baseline?.transcript?.currentShellTurn;
    if (!currentShellTurn) throw new Error("Shell reattach omitted its reconstruction");

    send({
      type: "shell_resize",
      id: "shell-resize-before-ack",
      executionId: "active-shell-intent",
      revision: 1,
      cols: 100,
      rows: 30,
    });
    await expect(response("shell-resize-before-ack")).resolves.toMatchObject({
      data: { accepted: false },
    });
    send({
      type: "shell_signal",
      id: "shell-signal-before-ack",
      executionId: "active-shell-intent",
      signal: "interrupt",
    });
    await expect(response("shell-signal-before-ack")).resolves.toMatchObject({
      data: { accepted: false },
    });

    send({
      type: "shell_reconstruction_ack",
      id: "shell-reconstruction-ack",
      executionId: "active-shell-intent",
      reconstructionFenceToken: currentShellTurn.reconstructionFenceToken,
      outputThroughSequence: currentShellTurn.outputThroughSequence,
    });
    await expect(response("shell-reconstruction-ack")).resolves.toMatchObject({
      data: { accepted: true },
    });
    send({
      type: "shell_resize",
      id: "shell-resize-after-ack",
      executionId: "active-shell-intent",
      revision: 1,
      cols: 100,
      rows: 30,
    });
    await expect(response("shell-resize-after-ack")).resolves.toMatchObject({
      data: { accepted: true },
    });
  });

  it("reports editor preflight as outcome unknown without pretending to cancel it", async () => {
    await submit("/test-editor-wait");
    const started = await waitForLog("started", "editor");
    await expect(requestEscape()).resolves.toMatchObject({
      disposition: "outcome_unknown",
      target: "editor",
    });
    expect(
      logs().some(
        (entry) =>
          entry.event === "cancelled" && entry.kind === "editor" && entry.token === started.token,
      ),
    ).toBe(false);
    await waitForLog("completed", "editor");
  });

  it("cancels compaction and bash without persisting or completing them", async () => {
    const compactId = command("compact");
    const compact = await waitForLog("started", "compaction");
    await expect(requestEscape()).resolves.toMatchObject({ target: "compaction" });
    await response(compactId);
    expect(
      logs().some((entry) => entry.event === "persisted" && entry.token === compact.token),
    ).toBe(false);

    const bashId = command("bash", { command: "test-long-bash" });
    const bash = await waitForLog("started", "bash");
    await expect(requestEscape()).resolves.toMatchObject({ target: "bash" });
    await response(bashId);
    expect(logs().some((entry) => entry.event === "completed" && entry.token === bash.token)).toBe(
      false,
    );
  });

  it("selects the documented priority across overlapping active operations", async () => {
    await submit("/test-overlap");
    await waitForLog("started", "bash");
    const targets: string[] = [];
    for (let index = 0; index < 5; index++) targets.push((await requestEscape()).target ?? "none");
    expect(targets).toEqual(["navigation", "compaction", "retry", "streaming", "bash"]);
  });

  it("reports idle without manufacturing cancellation or restoration", async () => {
    await expect(requestEscape()).resolves.toMatchObject({
      disposition: "already_inactive",
      target: "editor",
    });
    await expect(
      waitUntil(() => logs().find((entry) => entry.event === "escape" && entry.target === "idle")),
    ).resolves.toMatchObject({ target: "idle" });
    expect(logs().some((entry) => entry.event === "cancelled")).toBe(false);
    expect(messages.some((message) => message.type === "queue_restoration")).toBe(false);
  });

  it("correlates an empty streaming restoration with the escape result", async () => {
    await submit("hello empty queue [test:hold-streaming]");
    await waitForLog("started", "streaming");
    const result = await requestEscape();
    expect(result).toMatchObject({ target: "streaming", restorationId: expect.any(String) });
    const restoration = await waitUntil(() =>
      messages.find(
        (message) =>
          message.type === "queue_restoration" && message.restorationId === result.restorationId,
      ),
    );
    expect(restoration).toMatchObject({ steering: [], followUp: [], originalAttachments: [] });
    send({ type: "restoration_ack", restorationId: result.restorationId });
    await expect(waitForLog("restoration_ack")).resolves.toMatchObject({
      restorationId: result.restorationId,
    });
  });

  it("publishes cleared queued follow-up evidence exactly once when streaming is interrupted", async () => {
    await submit("hello queue owner [test:hold-streaming]");
    await waitForLog("started", "streaming");
    await submit("queued for review", "followUp", [
      { type: "image", data: "queued-image", mimeType: "image/png" },
    ]);
    await waitForLog("queued", "followUp");

    await expect(requestEscape()).resolves.toMatchObject({
      target: "streaming",
      restorationId: expect.any(String),
    });
    const restoration = await waitUntil(() =>
      messages.find((message) => message.type === "queue_restoration"),
    );
    expect(restoration).toMatchObject({
      steering: [],
      followUp: ["queued for review"],
      // ESC clears the queue before consumption, but its submission already
      // crossed visual clear. Main must drop, never reinsert, this payload.
      certainty: "not_processed",
      clearedIntentIds: [expect.any(String)],
      originalAttachments: [
        {
          images: [{ type: "image", data: "queued-image", mimeType: "image/png" }],
        },
      ],
    });
    expect(messages.filter((message) => message.type === "queue_restoration")).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(messages.filter((message) => message.type === "queue_restoration")).toHaveLength(1);
  });
});
