import type { SessionId } from "@shared/ids.js";
import type {
  IntentOutcome,
  IntentReceipt,
  SessionIntent,
  SessionQuery,
} from "@shared/pi-protocol/runtime-state.js";
import { describe, expect, it, vi } from "vitest";
import { type ExecuteDeps, InputNotConsumedError, executeAction } from "./execute.js";

const SID = "s1" as SessionId;
const owner = { hostInstanceId: "11111111-1111-4111-8111-111111111111", sessionEpoch: 1 };
function outcome(
  intentId: string,
  kind: IntentOutcome["kind"],
  state: IntentOutcome["state"] = "completed",
): IntentOutcome {
  return {
    intentId,
    owner,
    kind,
    state,
    ...(kind === "submit" ? { result: { disposition: "consumed", editorRevision: 2 } } : {}),
  } as IntentOutcome;
}
function depsFor(overrides: Partial<ExecuteDeps> = {}) {
  const dispatch = vi.fn(
    async (_sid: SessionId, _intent: SessionIntent, id?: string) =>
      ({ status: "admitted", intentId: id!, owner }) satisfies IntentReceipt,
  );
  const awaitIntentOutcome = vi.fn(async (_sid: SessionId, id: string, _owner: typeof owner) =>
    outcome(id, "submit"),
  );
  const query = vi.fn(async (_sid: SessionId, query: SessionQuery) => ({
    queryId: "q",
    owner,
    queryType: query.type,
    response: { type: "response", command: query.type, success: true, data: {} },
  }));
  const addToast = vi.fn();
  const deps: ExecuteDeps = {
    dispatch,
    awaitIntentOutcome,
    query: query as never,
    getIntentObservation: () => ({ owner, editorRevision: 2, userMessageSequence: 0 }),
    invoke: vi.fn(),
    addToast,
    addUserMessage: vi.fn(),
    addCustomMessage: vi.fn(),
    openChangelog: vi.fn(),
    openPicker: vi.fn(),
    closeSessionTab: vi.fn(),
    openAppSettings: vi.fn(),
    openLogin: vi.fn(),
    openDiffViewer: vi.fn(),
    openTreeViewer: vi.fn(),
    copyToClipboard: vi.fn(),
    getAvailableModels: () => [{ id: "m", provider: "p", name: "Model" }],
    getSessionWorkspacePath: () => "/tmp",
    listSessions: vi.fn(),
    ...overrides,
  };
  return { deps, dispatch, awaitIntentOutcome, query, addToast };
}

describe("Composer intent execution", () => {
  it("submits ordinary text as a submit intent and waits for its frame outcome", async () => {
    let release!: () => void;
    const delayed = new Promise<IntentOutcome>((resolve) => {
      release = () => resolve(outcome("ignored", "submit"));
    });
    const { deps } = depsFor({ awaitIntentOutcome: vi.fn(() => delayed) });
    const running = executeAction(SID, { kind: "send-prompt", text: "hello" }, deps);
    await Promise.resolve();
    expect(deps.dispatch).toHaveBeenCalledWith(
      SID,
      expect.objectContaining({ kind: "submit", text: "hello" }),
      expect.any(String),
    );
    expect(deps.awaitIntentOutcome).toHaveBeenCalled();
    release();
    await running;
  });

  it("does not treat an admitted receipt as completion", async () => {
    const { deps } = depsFor({
      dispatch: vi.fn(async (_sid, _intent, id) => ({
        status: "delivery_unknown" as const,
        intentId: id!,
        owner,
      })) as never,
    });
    await expect(executeAction(SID, { kind: "compact" }, deps)).rejects.toBeInstanceOf(
      InputNotConsumedError,
    );
    expect(deps.dispatch).toHaveBeenCalled();
  });

  it("routes bash, compact, rename, reload and extension slash text through intents", async () => {
    const { deps } = depsFor({
      awaitIntentOutcome: vi.fn(async (_sid, id, _owner) => outcome(id, "compact")),
    });
    await executeAction(SID, { kind: "compact", customInstructions: "short" }, deps);
    await executeAction(
      SID,
      { kind: "bash", command: "pwd", excludeFromContext: false },
      { ...deps, awaitIntentOutcome: vi.fn(async (_sid, id) => outcome(id, "runBash")) },
    );
    await executeAction(
      SID,
      { kind: "name", name: "Renamed" },
      { ...deps, awaitIntentOutcome: vi.fn(async (_sid, id) => outcome(id, "rename")) },
    );
    await executeAction(
      SID,
      { kind: "reload" },
      { ...deps, awaitIntentOutcome: vi.fn(async (_sid, id) => outcome(id, "reload")) },
    );
    await executeAction(
      SID,
      { kind: "send-prompt", text: "/extension", commandSource: "extension" },
      { ...deps, awaitIntentOutcome: vi.fn(async (_sid, id) => outcome(id, "invokeCommand")) },
    );
    expect(
      (deps.dispatch as ReturnType<typeof vi.fn>).mock.calls.map(
        (call) => (call[1] as SessionIntent).kind,
      ),
    ).toEqual(["compact", "runBash", "rename", "reload", "invokeCommand"]);
  });

  it("uses queries for read-only session operations", async () => {
    const { deps } = depsFor({
      query: vi.fn(async (_sid, q: SessionQuery) => ({
        queryId: "q",
        owner,
        queryType: q.type,
        response: {
          type: "response" as const,
          command: q.type,
          success: true,
          data: { messages: [], text: null },
        },
      })) as never,
    });
    await executeAction(SID, { kind: "fork" }, deps);
    await executeAction(SID, { kind: "copy" }, deps);
    await executeAction(SID, { kind: "session-info" }, deps);
    expect(
      (deps.query as ReturnType<typeof vi.fn>).mock.calls.map(
        (call) => (call[1] as SessionQuery).type,
      ),
    ).toEqual(
      expect.arrayContaining([
        "get_fork_messages",
        "get_last_assistant_text",
        "get_session_stats",
        "get_state",
      ]),
    );
  });
});
