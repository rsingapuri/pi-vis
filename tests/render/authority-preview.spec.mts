import { expect, test } from "@playwright/test";
import type {
  AuthorityAttachResponse,
  IntentReceipt,
  RendererPublication,
  SessionQueryResult,
} from "../../src/shared/pi-protocol/runtime-state.js";

test("preview implements owner-bound query/intent frames without legacy commands", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator(".composer__textarea")).toBeEnabled({ timeout: 20_000 });

  const result = await page.evaluate(async () => {
    type Stub = {
      invoke: <T>(channel: string, payload?: unknown) => Promise<T>;
      on: (channel: string, callback: (payload: RendererPublication) => void) => () => void;
    };
    const stub = (window as unknown as { pivis: Stub }).pivis;
    const store = (
      window as unknown as {
        __pivisStore: { getState: () => { activeSessionId: string | null } };
      }
    ).__pivisStore;
    const sessionId = store.getState().activeSessionId;
    if (!sessionId) throw new Error("missing active preview session");

    const attach = await stub.invoke<AuthorityAttachResponse>("session.authorityAttach", {
      sessionId,
      rendererGeneration: 99,
    });
    const owner = attach.baseline.owner;
    const query = await stub.invoke<SessionQueryResult>("session.query", {
      sessionId,
      queryId: "preview-query",
      expectedOwner: owner,
      observedCursor: attach.baseline.semantic.sync.cursor,
      query: { type: "get_available_models" },
    });

    const publications: RendererPublication[] = [];
    const unsubscribe = stub.on("session.publication", (publication) =>
      publications.push(publication),
    );
    const receipt = await stub.invoke<IntentReceipt>("session.dispatchIntent", {
      sessionId,
      intentId: "preview-set-model",
      rendererGeneration: 99,
      expectedOwner: owner,
      observedCursor: attach.baseline.semantic.sync.cursor,
      intent: { kind: "setModel", provider: "anthropic", modelId: "claude-fable-5" },
    });
    const publicationCountAtReceipt = publications.length;
    await new Promise<void>((resolve) => {
      const timer = window.setInterval(() => {
        if (publications.length > 0) {
          window.clearInterval(timer);
          resolve();
        }
      }, 10);
    });
    const duplicate = await stub.invoke<IntentReceipt>("session.dispatchIntent", {
      sessionId,
      intentId: "preview-set-model",
      rendererGeneration: 99,
      expectedOwner: owner,
      observedCursor: attach.baseline.semantic.sync.cursor,
      intent: { kind: "setModel", provider: "anthropic", modelId: "claude-fable-5" },
    });
    const legacy = await stub.invoke<undefined>("session.sendCommand", {});
    const publication = publications[0];
    if (!publication) throw new Error("missing authority publication");
    unsubscribe();
    return {
      attach,
      query,
      receipt,
      publicationCountAtReceipt,
      publication,
      duplicate,
      legacy,
    };
  });

  expect(result.attach.baseline.semantic.snapshot.sdk).toMatchObject({
    isStreaming: false,
    isIdle: true,
  });
  expect(result.query).toMatchObject({
    queryId: "preview-query",
    owner: result.attach.baseline.owner,
    queryType: "get_available_models",
  });
  expect(result.receipt).toMatchObject({
    status: "admitted",
    intentId: "preview-set-model",
  });
  // Receipt admission is not an authority completion or a projection mutation.
  expect(result.publicationCountAtReceipt).toBe(0);
  expect(result.publication).toMatchObject({
    plane: "semantic",
    owner: result.attach.baseline.owner,
    payload: {
      records: [
        {
          type: "intent_outcome",
          outcome: { intentId: "preview-set-model", kind: "setModel", state: "completed" },
        },
      ],
      terminalSnapshot: { model: { id: "claude-fable-5", provider: "anthropic" } },
    },
  });
  expect(result.publication.payload.transportSequence).toBe(
    result.attach.baseline.semantic.sync.cursor.transportSequence + 1,
  );
  expect(result.publication.payload.terminalSnapshot.snapshotSequence).toBeGreaterThan(
    result.attach.baseline.semantic.sync.cursor.snapshotSequence,
  );
  expect(result.duplicate).toMatchObject({
    status: "duplicate",
    intentId: "preview-set-model",
  });
  expect(result.legacy).toBeUndefined();
});
