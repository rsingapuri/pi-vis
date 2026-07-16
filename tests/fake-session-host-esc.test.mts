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
    ["hello cancellable stream", "streaming"],
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
    await submit("hello empty queue");
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
  });

  it("restores queued follow-up text exactly once when streaming is interrupted", async () => {
    await submit("hello queue owner");
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
      // ESC clears the queue before consumption; like real Pi's requestEscape
      // this is not_processed custody that main always restores to the draft.
      certainty: "not_processed",
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
