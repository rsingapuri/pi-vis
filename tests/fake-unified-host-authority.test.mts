import { type ChildProcess, fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AgentSessionSnapshotSchema,
  AuthorityAttachBaselineResponseSchema,
  AuthorityFrameSchema,
  AuthorityPresentationPublicationSchema,
} from "../src/shared/pi-protocol/runtime-state.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/fake-unified-host.mjs", import.meta.url));

interface WireMessage {
  type?: string;
  id?: string;
  success?: boolean;
  data?: unknown;
  payload?: { type?: string };
  frame?: unknown;
  publication?: unknown;
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

describe("fake unified host authority protocol", () => {
  let child: ChildProcess;
  let messages: WireMessage[];

  const send = (message: Record<string, unknown>) => child.send?.(message);
  const response = (id: string) =>
    waitUntil(() => messages.find((message) => message.type === "response" && message.id === id));

  beforeEach(async () => {
    messages = [];
    child = fork(FIXTURE, [], {
      stdio: ["ignore", "ignore", "pipe", "ipc"],
      serialization: "advanced",
    });
    child.on("message", (message) => messages.push(message as WireMessage));
    send({ type: "init" });
    await waitUntil(() =>
      messages.find((message) => message.type === "control" && message.payload?.type === "ready"),
    );
    await waitUntil(() => messages.find((message) => message.type === "panel_open"));
  });

  afterEach(() => child.kill("SIGKILL"));

  it("publishes valid direct state, attach keyframe, semantic frames, and fenced panel input", async () => {
    send({ type: "state_request", id: "state" });
    const state = await response("state");
    AgentSessionSnapshotSchema.parse(state.data);

    send({ type: "authority_attach", id: "attach", rendererGeneration: 4 });
    const attached = await response("attach");
    // Child attach responses are a status union so a transition can answer
    // "transitioning" instead of blocking; a settled fixture must be ready.
    const attachResponse = AuthorityAttachBaselineResponseSchema.parse(attached.data);
    if (attachResponse.status !== "ready") {
      throw new Error(`Expected ready attach baseline, got ${attachResponse.status}`);
    }
    const baseline = attachResponse.baseline;
    expect(baseline.semantic.snapshot.owner).toEqual(baseline.owner);
    expect(baseline.transcript.sync.state).toBe("following");
    expect(baseline.extensionUi.sync.state).toBe("following");
    expect(baseline.panels).toHaveLength(1);
    expect(baseline.panels[0]).toMatchObject({
      owner: baseline.owner,
      unified: true,
      sync: { state: "following" },
      keyframe: { kind: "keyframe" },
    });

    const frame = AuthorityFrameSchema.parse(
      messages.find((message) => message.type === "authority_frame")?.frame,
    );
    expect(frame.owner).toEqual(baseline.owner);

    const publications = messages
      .filter((message) => message.type === "authority_publication")
      .map((message) => AuthorityPresentationPublicationSchema.parse(message.publication));
    const panelPublications = publications.filter((publication) => publication.plane === "panel");
    expect(panelPublications.map((publication) => publication.payload.kind)).toEqual(
      expect.arrayContaining(["reset", "keyframe", "ansi_delta"]),
    );
    expect(
      panelPublications.map((publication) => publication.payload.cursor.transportSequence),
    ).toEqual(panelPublications.map((_, index) => index + 1));

    const panel = baseline.panels[0];
    send({
      type: "panel_input",
      id: "fenced-input",
      panelId: panel.panelId,
      revision: panel.keyframe.renderRevision,
      sequence: 1,
      data: "x",
    });
    await expect(response("fenced-input")).resolves.toMatchObject({
      data: { acknowledgedThrough: 0, repaintRequired: { repaintRequired: true } },
    });

    send({
      type: "panel_repaint_ack",
      id: "repaint-ack",
      panelId: panel.panelId,
      revision: panel.keyframe.renderRevision,
    });
    await expect(response("repaint-ack")).resolves.toMatchObject({ data: { acknowledged: true } });
    send({
      type: "panel_input",
      id: "accepted-input",
      panelId: panel.panelId,
      revision: panel.keyframe.renderRevision,
      sequence: 1,
      data: "x",
    });
    await expect(response("accepted-input")).resolves.toMatchObject({
      data: { acknowledgedThrough: 1 },
    });

    send({ type: "panel_close_request", panelId: panel.panelId });
    const closed = await waitUntil(() =>
      messages.find(
        (message) =>
          message.type === "authority_publication" &&
          (message.publication as { plane?: string; payload?: { kind?: string } })?.plane ===
            "panel" &&
          (message.publication as { payload?: { kind?: string } })?.payload?.kind === "close",
      ),
    );
    expect(AuthorityPresentationPublicationSchema.parse(closed.publication)).toMatchObject({
      plane: "panel",
      payload: { kind: "close" },
    });
  });
});
