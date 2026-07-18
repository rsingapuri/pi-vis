import type { SessionId } from "@shared/ids.js";
import type {
  IntentOutcome,
  IntentReceipt,
  SessionIntent,
  SessionQuery,
  SessionQueryResult,
} from "@shared/pi-protocol/runtime-state.js";
import { describe, expect, it, vi } from "vitest";
import { type ExecuteDeps, InputNotConsumedError, executeAction } from "./execute.js";

const SID = "s1" as SessionId;
const OWNER = { hostInstanceId: "11111111-1111-4111-8111-111111111111", sessionEpoch: 1 };

function authoritativeOutcome(
  intentId: string,
  kind: IntentOutcome["kind"],
  state: IntentOutcome["state"] = "completed",
  extra: Record<string, unknown> = {},
): IntentOutcome {
  const result =
    kind === "submit"
      ? { disposition: "consumed", editorRevision: 3 }
      : kind === "runBash"
        ? { started: true }
        : kind === "setModel"
          ? { provider: "anthropic", modelId: "claude-haiku" }
          : kind === "rename"
            ? { name: "Renamed" }
            : kind === "export"
              ? { path: "/tmp/export.html" }
              : {};
  return { intentId, owner: OWNER, kind, state, result, ...extra } as IntentOutcome;
}

function queryResult(query: SessionQuery, data: unknown): SessionQueryResult {
  return {
    status: "ok",
    queryId: "query-1",
    owner: OWNER,
    queryType: query.type,
    response: { type: "response", command: query.type, success: true, data },
  } as SessionQueryResult;
}

function defaultQueryData(query: SessionQuery): unknown {
  switch (query.type) {
    case "get_state":
      return { sessionId: "ses-1", sessionName: "Existing Name", sessionFile: "/tmp/s.jsonl" };
    case "get_session_stats":
      return { userMessages: 2, assistantMessages: 1, totalMessages: 3 };
    case "get_fork_messages":
      return { messages: [] };
    case "get_last_assistant_text":
      return { text: null };
    case "get_scoped_models":
      return { models: [], enabledIds: null };
    case "get_login_providers":
      return { native: true, providers: [] };
    case "get_logout_providers":
      return { providers: [] };
    case "get_trust_state":
      return { hasTrustRequiringResources: false };
    default:
      return {};
  }
}

function depsFor(overrides: Partial<ExecuteDeps> = {}) {
  const kinds = new Map<string, IntentOutcome["kind"]>();
  const dispatch = vi.fn(async (_sid: SessionId, intent: SessionIntent, intentId?: string) => {
    kinds.set(intentId!, intent.kind);
    return { status: "admitted", intentId: intentId!, owner: OWNER } satisfies IntentReceipt;
  });
  const awaitIntentOutcome = vi.fn(async (_sid: SessionId, intentId: string) =>
    authoritativeOutcome(intentId, kinds.get(intentId) ?? "submit"),
  );
  const query = vi.fn(async (_sid: SessionId, request: SessionQuery) =>
    queryResult(request, defaultQueryData(request)),
  );
  const deps: ExecuteDeps = {
    dispatch,
    awaitIntentOutcome,
    query,
    getIntentObservation: () => ({ owner: OWNER, editorRevision: 2, userMessageSequence: 7 }),
    invoke: vi.fn(async () => ({ success: true, data: {} })) as ExecuteDeps["invoke"],
    addToast: vi.fn(),
    addUserMessage: vi.fn(),
    addCustomMessage: vi.fn(),
    openChangelog: vi.fn(),
    openPicker: vi.fn(),
    closeSessionTab: vi.fn(async () => {}),
    openAppSettings: vi.fn(),
    openLogin: vi.fn(),
    openDiffViewer: vi.fn(),
    openTreeViewer: vi.fn(),
    copyToClipboard: vi.fn(async () => {}),
    getAvailableModels: () => [
      { id: "claude-sonnet-4", provider: "anthropic", name: "Claude Sonnet 4" },
      { id: "deepseek-v3", provider: "deepseek", name: "DeepSeek V3" },
      { id: "claude-haiku", provider: "anthropic", name: "Claude Haiku" },
    ],
    getSessionWorkspacePath: () => "/tmp/ws",
    listSessions: vi.fn(async () => []),
    ...overrides,
  };
  return { deps, dispatch, awaitIntentOutcome, query };
}

describe("Composer intent execution — prompts and effects", () => {
  it("submits prompt context through an intent and waits for the authoritative outcome", async () => {
    let resolveOutcome!: (outcome: IntentOutcome) => void;
    const outcomePromise = new Promise<IntentOutcome>((resolve) => {
      resolveOutcome = resolve;
    });
    const { deps } = depsFor({
      awaitIntentOutcome: vi.fn(() => outcomePromise),
    });

    const execution = executeAction(
      SID,
      {
        kind: "send-prompt",
        text: "hello",
        images: [{ data: "bytes", mimeType: "image/png", dataUrl: "data:image/png;base64,bytes" }],
      },
      deps,
    );
    await vi.waitFor(() => expect(deps.awaitIntentOutcome).toHaveBeenCalled());

    expect(deps.dispatch).toHaveBeenCalledWith(
      SID,
      {
        kind: "submit",
        editorRevision: 2,
        text: "hello",
        images: [{ type: "image", data: "bytes", mimeType: "image/png" }],
        requestedMode: "steer",
        surface: "composer",
      },
      expect.any(String),
    );
    expect(deps.awaitIntentOutcome).toHaveBeenCalledWith(SID, expect.any(String), OWNER);
    // A receipt is admission only: it cannot create an optimistic canonical echo or clear input.
    expect(deps.addUserMessage).not.toHaveBeenCalled();

    const intentId = (deps.dispatch as ReturnType<typeof vi.fn>).mock.calls[0]![2]!;
    resolveOutcome(
      authoritativeOutcome(intentId, "submit", "completed", {
        result: { disposition: "consumed", editorRevision: 3, queued: true },
      }),
    );
    await execution;
    // A queued submission remains in the pending queue manager until Pi emits
    // the authoritative user message; it must not look delivered in history.
    expect(deps.addUserMessage).not.toHaveBeenCalled();
  });

  it("uses invokeCommand for discovered slash text and never creates a prompt echo", async () => {
    const { deps, dispatch } = depsFor({ uiSurface: "unified" });
    await executeAction(
      SID,
      { kind: "send-prompt", text: "/extension", commandSource: "extension" },
      deps,
    );
    expect(dispatch).toHaveBeenCalledWith(
      SID,
      { kind: "invokeCommand", text: "/extension", editorRevision: 2 },
      expect.any(String),
    );
    expect(deps.addUserMessage).not.toHaveBeenCalled();
  });

  it("surfaces a failed extension command while leaving it consumed", async () => {
    const { deps } = depsFor({
      awaitIntentOutcome: vi.fn(async (_sid, intentId) =>
        authoritativeOutcome(intentId, "invokeCommand", "failed", {
          error: "extension exploded",
        }),
      ),
    });

    const completion = await executeAction(
      SID,
      { kind: "send-prompt", text: "/extension", commandSource: "extension" },
      deps,
    );

    expect(completion?.outcome.state).toBe("failed");
    expect(deps.addToast).toHaveBeenCalledWith(SID, "extension exploded", "error");
    expect(deps.addUserMessage).not.toHaveBeenCalled();
  });

  it("does not replay an effect after delivery ambiguity and preserves editor custody", async () => {
    const { deps } = depsFor({
      dispatch: vi.fn(async (_sid, _intent, intentId) => ({
        status: "delivery_unknown" as const,
        intentId: intentId!,
        owner: OWNER,
      })) as NonNullable<ExecuteDeps["dispatch"]>,
    });
    await expect(
      executeAction(SID, { kind: "bash", command: "pwd", excludeFromContext: false }, deps),
    ).rejects.toBeInstanceOf(InputNotConsumedError);
    expect(deps.dispatch).toHaveBeenCalledTimes(1);
    expect(deps.awaitIntentOutcome).not.toHaveBeenCalled();
    expect(deps.addUserMessage).not.toHaveBeenCalled();
  });

  it("does not replay an admitted effect whose authoritative outcome is unknown", async () => {
    const { deps } = depsFor({
      awaitIntentOutcome: vi.fn(async (_sid, intentId) =>
        authoritativeOutcome(intentId, "compact", "outcome_unknown", { error: "host lost" }),
      ),
    });
    await expect(executeAction(SID, { kind: "compact" }, deps)).rejects.toThrow("host lost");
    expect(deps.dispatch).toHaveBeenCalledTimes(1);
    expect(deps.awaitIntentOutcome).toHaveBeenCalledTimes(1);
  });

  it("does not dispatch or clear editor-owned content when the owner is stale", async () => {
    const { deps } = depsFor({
      dispatch: vi.fn(async (_sid, _intent, intentId) => ({
        status: "not_admitted" as const,
        intentId: intentId!,
        reason: "stale_owner" as const,
      })) as NonNullable<ExecuteDeps["dispatch"]>,
    });
    await expect(
      executeAction(SID, { kind: "send-prompt", text: "predecessor" }, deps),
    ).rejects.toThrow(/stale owner/);
    expect(deps.dispatch).toHaveBeenCalledTimes(1);
    expect(deps.awaitIntentOutcome).not.toHaveBeenCalled();
    expect(deps.addUserMessage).not.toHaveBeenCalled();
  });

  it("runs bash through runBash and does not fabricate transcript output from admission", async () => {
    const { deps, dispatch } = depsFor();
    await executeAction(SID, { kind: "bash", command: "ls", excludeFromContext: true }, deps);
    expect(dispatch).toHaveBeenCalledWith(
      SID,
      { kind: "runBash", command: "ls", excludeFromContext: true },
      expect.any(String),
    );
    expect(deps.addCustomMessage).not.toHaveBeenCalled();
  });

  it("passes compact instructions and surfaces only its terminal domain failure", async () => {
    const { deps, dispatch } = depsFor({
      awaitIntentOutcome: vi.fn(async (_sid, intentId) =>
        authoritativeOutcome(intentId, "compact", "failed", { error: "Nothing to compact" }),
      ),
    });
    await executeAction(SID, { kind: "compact", customInstructions: "short" }, deps);
    expect(dispatch).toHaveBeenCalledWith(
      SID,
      { kind: "compact", instructions: "short" },
      expect.any(String),
    );
    expect(deps.addToast).toHaveBeenCalledWith(SID, "Nothing to compact", "error");
  });
});

describe("Composer intent execution — model, name, and replacement commands", () => {
  it("opens the model picker for no match or an ambiguous providerless model", async () => {
    const noMatch = depsFor();
    await executeAction(SID, { kind: "model", search: "nope" }, noMatch.deps);
    expect(noMatch.deps.openPicker).toHaveBeenCalledWith(SID, { kind: "model", search: "nope" });

    const ambiguous = depsFor({
      getAvailableModels: () => [
        { id: "same", provider: "one", name: "One" },
        { id: "same", provider: "two", name: "Two" },
      ],
    });
    await executeAction(SID, { kind: "model", search: "same" }, ambiguous.deps);
    expect(ambiguous.deps.openPicker).toHaveBeenCalledWith(SID, { kind: "model", search: "same" });
    expect(ambiguous.dispatch).not.toHaveBeenCalled();
  });

  it("sets exact provider/id through setModel intents and leaves providerless references in the picker", async () => {
    const exact = depsFor();
    await executeAction(SID, { kind: "model", search: "ANTHROPIC/CLAUDE-HAIKU" }, exact.deps);
    expect(exact.dispatch).toHaveBeenCalledWith(
      SID,
      { kind: "setModel", provider: "anthropic", modelId: "claude-haiku" },
      expect.any(String),
    );
    expect(exact.deps.addToast).toHaveBeenCalledWith(SID, "Model: Claude Haiku [anthropic]");

    const providerless = depsFor({
      getAvailableModels: () => [{ id: "local", name: "Local Model" }],
    });
    await executeAction(SID, { kind: "model", search: "LOCAL" }, providerless.deps);
    expect(providerless.deps.openPicker).toHaveBeenCalledWith(SID, {
      kind: "model",
      search: "LOCAL",
    });
    expect(providerless.dispatch).not.toHaveBeenCalled();
  });

  it("uses an authoritative rename outcome before showing success and queries the current name", async () => {
    const renamed = depsFor();
    await executeAction(SID, { kind: "name", name: "Renamed" }, renamed.deps);
    expect(renamed.dispatch).toHaveBeenCalledWith(
      SID,
      { kind: "rename", name: "Renamed" },
      expect.any(String),
    );
    expect(renamed.deps.addToast).toHaveBeenCalledWith(SID, "Session name set: Renamed");

    const current = depsFor();
    await executeAction(SID, { kind: "name" }, current.deps);
    expect(current.query).toHaveBeenCalledWith(SID, { type: "get_state" });
    expect(current.deps.addToast).toHaveBeenCalledWith(
      SID,
      "Session name: Existing Name",
      undefined,
    );
  });

  it("routes replacement commands through terminal invokeCommand outcomes", async () => {
    const { deps, dispatch } = depsFor();
    await executeAction(SID, { kind: "new-session" }, deps);
    await executeAction(SID, { kind: "clone" }, deps);
    expect(dispatch.mock.calls.map(([, intent]) => intent)).toEqual([
      { kind: "invokeCommand", text: "/new", editorRevision: 2 },
      { kind: "invokeCommand", text: "/clone", editorRevision: 2 },
    ]);
    expect(deps.addToast).toHaveBeenCalledWith(SID, "Started a fresh session");
    expect(deps.addToast).toHaveBeenCalledWith(SID, "Cloned to new session");
  });

  it("routes export through an owner-bound effect intent and reports its authority failure", async () => {
    const { deps, dispatch } = depsFor({
      awaitIntentOutcome: vi.fn(async (_sid, intentId) =>
        authoritativeOutcome(intentId, "export", "failed", { error: "write denied" }),
      ),
    });
    await executeAction(SID, { kind: "export", outputPath: "/tmp/export.html" }, deps);
    expect(dispatch).toHaveBeenCalledWith(
      SID,
      { kind: "export", outputPath: "/tmp/export.html" },
      expect.any(String),
    );
    expect(deps.addToast).toHaveBeenCalledWith(
      SID,
      "Failed to export session: write denied",
      "error",
    );
  });

  it("waits for the authoritative export path before invoking main-only sharing", async () => {
    const invoke = vi.fn(async () => ({
      ok: true,
      url: "https://pi.dev/session/#gist",
      gistUrl: "https://gist.github.com/test/gist",
    }));
    const { deps, dispatch } = depsFor({
      invoke: invoke as unknown as ExecuteDeps["invoke"],
    });
    await executeAction(SID, { kind: "share" }, deps);
    const [, , intentId] = dispatch.mock.calls[0]!;
    expect(dispatch).toHaveBeenCalledWith(SID, { kind: "export" }, expect.any(String));
    expect(invoke).toHaveBeenCalledWith("session.share", {
      sessionId: SID,
      expectedHostInstanceId: OWNER.hostInstanceId,
      expectedSessionEpoch: OWNER.sessionEpoch,
      exportIntentId: intentId,
      exportedPath: "/tmp/export.html",
    });
  });
});

describe("Composer intent execution — read-only queries", () => {
  it("uses query results to populate fork and copy without turning reads into intents", async () => {
    const { deps, dispatch } = depsFor({
      query: vi.fn(async (_sid, request: SessionQuery) => {
        if (request.type === "get_fork_messages")
          return queryResult(request, { messages: [{ entryId: "e1", text: "first" }] });
        if (request.type === "get_last_assistant_text")
          return queryResult(request, { text: "answer" });
        return queryResult(request, defaultQueryData(request));
      }),
    });
    await executeAction(SID, { kind: "fork" }, deps);
    await executeAction(SID, { kind: "copy" }, deps);
    expect(deps.query).toHaveBeenCalledWith(SID, { type: "get_fork_messages" });
    expect(deps.query).toHaveBeenCalledWith(SID, { type: "get_last_assistant_text" });
    expect(deps.openPicker).toHaveBeenCalledWith(SID, {
      kind: "fork",
      messages: [{ entryId: "e1", text: "first" }],
    });
    expect(deps.copyToClipboard).toHaveBeenCalledWith("answer");
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("keeps empty fork and copy results as warnings", async () => {
    const { deps } = depsFor();
    await executeAction(SID, { kind: "fork" }, deps);
    await executeAction(SID, { kind: "copy" }, deps);
    expect(deps.addToast).toHaveBeenCalledWith(SID, "No messages to fork from", "warning");
    expect(deps.addToast).toHaveBeenCalledWith(SID, "No agent messages to copy yet.", "warning");
  });

  it("opens trust, scoped-model, and logout pickers only from their query fixtures", async () => {
    const option = { label: "Trust folder", trusted: true, updates: [] };
    const { deps, dispatch } = depsFor({
      query: vi.fn(async (_sid, request: SessionQuery) => {
        if (request.type === "get_trust_state")
          return queryResult(request, {
            cwd: "/tmp/ws",
            savedDecision: null,
            projectTrusted: false,
            hasTrustRequiringResources: true,
            currentOptions: [option],
          });
        if (request.type === "get_scoped_models")
          return queryResult(request, {
            models: [{ id: "m", provider: "p", name: "Model" }],
            enabledIds: ["p/m"],
          });
        if (request.type === "get_logout_providers")
          return queryResult(request, {
            providers: [{ id: "p", name: "Provider", authType: "api_key" }],
          });
        return queryResult(request, defaultQueryData(request));
      }),
    });
    await executeAction(SID, { kind: "trust" }, deps);
    await executeAction(SID, { kind: "scoped-models" }, deps);
    await executeAction(SID, { kind: "logout" }, deps);
    expect(
      (deps.query as ReturnType<typeof vi.fn>).mock.calls.map(([, request]) => request.type),
    ).toEqual(["get_trust_state", "get_scoped_models", "get_logout_providers"]);
    expect(deps.openPicker).toHaveBeenCalledWith(
      SID,
      expect.objectContaining({ kind: "trust", options: [option] }),
    );
    expect(deps.openPicker).toHaveBeenCalledWith(
      SID,
      expect.objectContaining({ kind: "scoped-models", enabledIds: ["p/m"] }),
    );
    expect(deps.openPicker).toHaveBeenCalledWith(
      SID,
      expect.objectContaining({
        kind: "logout",
        providers: [expect.objectContaining({ id: "p" })],
      }),
    );
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("opens the runtime-derived sign-in picker and retains terminal fallback for legacy hosts", async () => {
    const providerCatalog = {
      native: true,
      providers: [
        {
          id: "project-provider",
          name: "Project Provider",
          configured: false,
          methods: ["oauth", "api_key"],
        },
      ],
    };
    const { deps } = depsFor({
      query: vi.fn(async (_sid: SessionId, request: SessionQuery) =>
        queryResult(request, providerCatalog),
      ),
    });

    await executeAction(SID, { kind: "open-login" }, deps);

    expect(deps.openPicker).toHaveBeenCalledWith(SID, {
      kind: "login",
      providers: providerCatalog.providers,
    });
    expect(deps.openLogin).not.toHaveBeenCalled();

    const legacy = depsFor({
      query: vi.fn(async (_sid: SessionId, request: SessionQuery) =>
        queryResult(request, { native: false, providers: [] }),
      ),
    }).deps;
    await executeAction(SID, { kind: "open-login" }, legacy);
    expect(legacy.openLogin).toHaveBeenCalledTimes(1);
    expect(legacy.openPicker).not.toHaveBeenCalled();
  });

  it("does not fabricate pickers when authoritative reads are empty", async () => {
    const { deps } = depsFor();
    await executeAction(SID, { kind: "trust" }, deps);
    await executeAction(SID, { kind: "scoped-models" }, deps);
    await executeAction(SID, { kind: "logout" }, deps);
    expect(deps.openPicker).not.toHaveBeenCalled();
    expect(deps.addToast).toHaveBeenCalledWith(
      SID,
      "This workspace has no project-local pi resources that require trust.",
      "info",
    );
    expect(deps.addToast).toHaveBeenCalledWith(SID, "No models available", "warning");
    expect(deps.addToast).toHaveBeenCalledWith(
      SID,
      "No stored credentials to remove. /logout only removes credentials saved by /login; environment variables and models.json config are unchanged.",
      "warning",
    );
  });
});
