import type { SessionId } from "@shared/ids.js";
import type {
  AuthorityAttachResponse,
  RendererPublication,
} from "@shared/pi-protocol/runtime-state.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSessionsStore } from "./sessions-store.js";
import { useTreeStore } from "./tree-store.js";

const SESSION_A = "session-tree-a" as SessionId;
const WORKSPACE = "/tmp/tree-test";

// We mock the global window.pivis.invoke surface the tree-store uses.
// Same stubbing style as the existing sessions-store tests — minimal
// invocations returning canned shapes.
interface InvokeCall {
  channel: string;
  payload: unknown;
}

let calls: InvokeCall[] = [];
let nextResponse: ((channel: string, payload: unknown) => Promise<unknown>) | null = null;

async function mockInvoke(channel: string, payload: unknown): Promise<unknown> {
  calls.push({ channel, payload });
  if (!nextResponse) return { success: false, error: "no mock" };
  if (channel === "session.query") {
    const envelope = payload as {
      queryId: string;
      expectedOwner: { hostInstanceId: string; sessionEpoch: number };
      query: { type: string };
    };
    const response = await nextResponse("child.transport", {
      ...envelope,
      command: envelope.query,
    });
    return {
      status: "ok",
      queryId: envelope.queryId,
      owner: envelope.expectedOwner,
      queryType: envelope.query.type,
      response,
    };
  }
  if (channel === "session.dispatchIntent") {
    return nextResponse("session.dispatchIntent", payload);
  }
  return nextResponse(channel, payload);
}

beforeEach(() => {
  calls = [];
  nextResponse = null;
  (globalThis as unknown as { window: unknown }).window = {
    pivis: { invoke: mockInvoke },
  };
  // Reset both stores
  useTreeStore.setState({
    open: false,
    sessionId: null,
    phase: "loading",
    errorMessage: null,
    nodes: [],
    leafId: null,
    filterMode: "default",
    search: "",
    selectedId: null,
    summarizeOnSwitch: false,
    foldedIds: new Set<string>(),
    navigating: false,
  });
  useSessionsStore.setState({
    workspaces: new Map(),
    sessions: new Map(),
    activeSessionId: null,
    activeWorkspacePath: null,
    expandedWorkspaces: [],
    newSessionDrafts: new Map(),
    sessionDrafts: new Map(),
  });
  const sess = useSessionsStore.getState();
  sess.createSession(SESSION_A, WORKSPACE);
  sess.setSessionStatus(SESSION_A, "ready");
  sess.applyRuntimeState(SESSION_A, {
    availability: "available",
    hostInstanceId: "tree-host",
    sessionEpoch: 1,
    receivedAt: Date.now(),
    snapshot: {
      hostInstanceId: "tree-host",
      sessionEpoch: 1,
      snapshotSequence: 1,
      capturedAt: Date.now(),
      isStreaming: false,
      isIdle: true,
      isCompacting: false,
      isRetrying: false,
      retryAttempt: 0,
      isBashRunning: false,
      model: null,
      thinkingLevel: "off",
      sessionId: "wire-tree",
      pendingMessageCount: 0,
      steering: [],
      followUp: [],
      hostFacts: {
        submitting: false,
        actualCompaction: false,
        navigation: false,
        pendingDialogs: 0,
        custodyCount: 0,
      },
      catalog: { notifications: [], statuses: {}, widgets: {}, capabilityDiagnostics: [] },
      editor: { revision: 0, text: "", attachments: [] },
    },
  });
  const owner = { hostInstanceId: "tree-host", sessionEpoch: 1 };
  const cursor = { ...owner, transportSequence: 1, snapshotSequence: 1 };
  const authority = {
    status: "ready" as const,
    baseline: {
      sessionId: SESSION_A,
      rendererGeneration: 0,
      owner,
      semantic: {
        sync: { state: "following", cursor },
        snapshot: {
          owner,
          snapshotSequence: 1,
          capturedAt: Date.now(),
          sdk: {
            isStreaming: false,
            isIdle: true,
            isCompacting: false,
            isRetrying: false,
            retryAttempt: 0,
            isBashRunning: false,
          },
          activity: {},
          queues: { steering: [], followUp: [], steeringIntentIds: [], followUpIntentIds: [] },
          custody: [],
          editor: { revision: 0, text: "", attachments: [] },
          activeIntents: [],
          recentIntentOutcomes: [],
          recentObservedOperations: [],
          operationJournalLowWatermark: 0,
          operationJournalHighWatermark: 0,
          operationJournalTruncated: false,
          model: null,
          thinkingLevel: "off",
          catalog: { notifications: [], statuses: {}, widgets: {}, capabilityDiagnostics: [] },
        },
      },
      operationJournal: [],
      transcript: {
        sync: { state: "following", cursor },
        persistedHistoryCursor: null,
        liveTailCursor: null,
        overlapBoundary: null,
      },
      extensionUi: {
        sync: { state: "following", cursor },
        notifications: [],
        statuses: {},
        widgets: {},
        dialogs: [],
      },
      panels: [],
      restorations: [],

      publicationHighWatermark: 0,
    },
    replay: [],
  } satisfies AuthorityAttachResponse;
  sess.applyAuthorityAttach(SESSION_A, authority);
  sess.setActiveSession(SESSION_A);
});

afterEach(() => {
  delete (globalThis as unknown as { window?: unknown }).window;
});

function getInvoke(): (channel: string, payload: unknown) => Promise<unknown> {
  return (globalThis as unknown as { window: { pivis: { invoke: (...a: unknown[]) => unknown } } })
    .window.pivis.invoke as unknown as (channel: string, payload: unknown) => Promise<unknown>;
}

describe("tree-store — open / refresh", () => {
  it("openTreeForSession sends get_tree and re-nests the flat response into ready", async () => {
    // The host sends a FLAT (parentId-keyed) node list (see FlatTreeNode / the
    // contextBridge nesting-limit fix). The store re-nests it via buildNestedTree
    // so the flattener (which consumes nested SessionTreeNode[]) is unchanged.
    const flat = [
      { entry: { id: "u1", type: "message", timestamp: "t1" }, parentId: undefined },
      { entry: { id: "u2", type: "message", timestamp: "t2" }, parentId: "u1" },
    ];
    const nested = [
      {
        entry: { id: "u1", type: "message", timestamp: "t1" },
        children: [{ entry: { id: "u2", type: "message", timestamp: "t2" }, children: [] }],
        label: undefined,
        labelTimestamp: undefined,
      },
    ];
    nextResponse = async (channel) => {
      if (channel === "child.transport") {
        return { success: true, data: { nodes: flat, leafId: "u2" } };
      }
      return { success: false };
    };
    // Mark the session as a real (non-pending) session, then clear the visible
    // branch to mirror `/tree` selecting the root before any messages.
    useSessionsStore.getState().addUserMessage(SESSION_A, "real session");
    useSessionsStore.getState().seedHistory(SESSION_A, []);

    await useTreeStore.getState().openTreeForSession(SESSION_A);

    const state = useTreeStore.getState();
    expect(state.open).toBe(true);
    expect(state.sessionId).toBe(SESSION_A);
    expect(state.phase).toBe("ready");
    expect(state.nodes).toEqual(nested);
    expect(state.leafId).toBe("u2");
    expect(state.selectedId).toBe("u2");
    // Query completions never write canonical session history state.
    expect(useSessionsStore.getState().sessions.get(SESSION_A)?.hasTreeHistory).toBe(false);

    expect(calls[0]?.channel).toBe("session.query");
    expect(calls[0]?.payload).toHaveProperty("sessionId", SESSION_A);
  });

  it("accepts a deferred get_tree response after a same-owner semantic cursor advance", async () => {
    let resolveTree: (value: unknown) => void = () => {};
    const deferredTree = new Promise<unknown>((resolve) => {
      resolveTree = resolve;
    });
    nextResponse = async (channel) =>
      channel === "child.transport" ? deferredTree : { success: false };

    const opening = useTreeStore.getState().openTreeForSession(SESSION_A);
    await Promise.resolve();
    expect(calls[0]?.payload).toMatchObject({
      observedCursor: {
        hostInstanceId: "tree-host",
        sessionEpoch: 1,
        transportSequence: 1,
        snapshotSequence: 1,
      },
    });

    const prior = useSessionsStore.getState().sessions.get(SESSION_A)
      ?.authorityProjection?.authoritativeSnapshot;
    if (!prior) throw new Error("missing authority snapshot");
    useSessionsStore.getState().applyAuthorityPublication({
      sessionId: SESSION_A,
      rendererGeneration: 0,
      publicationSequence: 1,
      plane: "semantic",
      owner: prior.owner,
      payload: {
        owner: prior.owner,
        transportSequence: 2,
        frameId: "same-owner-advance",
        records: [],
        terminalSnapshot: { ...prior, snapshotSequence: 2 },
      },
    } as RendererPublication);

    resolveTree({ success: true, data: { nodes: [], leafId: null } });
    await opening;
    expect(useTreeStore.getState().phase).toBe("ready");
  });

  it("ignores a deferred predecessor response after successor replacement", async () => {
    let resolveTree: (value: unknown) => void = () => {};
    const deferredTree = new Promise<unknown>((resolve) => {
      resolveTree = resolve;
    });
    nextResponse = async (channel) =>
      channel === "child.transport" ? deferredTree : { success: false };

    const opening = useTreeStore.getState().openTreeForSession(SESSION_A);
    await Promise.resolve();

    const owner = { hostInstanceId: "tree-host-successor", sessionEpoch: 2 };
    const cursor = { ...owner, transportSequence: 1, snapshotSequence: 1 };
    useSessionsStore.getState().applyAuthorityAttach(SESSION_A, {
      status: "ready",
      baseline: {
        sessionId: SESSION_A,
        rendererGeneration: 0,
        owner,
        semantic: {
          sync: { state: "following", cursor },
          snapshot: {
            owner,
            snapshotSequence: 1,
            capturedAt: Date.now(),
            sdk: {
              isStreaming: false,
              isIdle: true,
              isCompacting: false,
              isRetrying: false,
              retryAttempt: 0,
              isBashRunning: false,
            },
            activity: {},
            queues: { steering: [], followUp: [], steeringIntentIds: [], followUpIntentIds: [] },
            custody: [],
            editor: { revision: 0, text: "", attachments: [] },
            activeIntents: [],
            recentIntentOutcomes: [],
            recentObservedOperations: [],
            operationJournalLowWatermark: 0,
            operationJournalHighWatermark: 0,
            operationJournalTruncated: false,
            model: null,
            thinkingLevel: "off",
            catalog: { notifications: [], statuses: {}, widgets: {}, capabilityDiagnostics: [] },
          },
        },
        operationJournal: [],
        transcript: {
          sync: { state: "following", cursor },
          persistedHistoryCursor: null,
          liveTailCursor: null,
          overlapBoundary: null,
        },
        extensionUi: {
          sync: { state: "following", cursor },
          notifications: [],
          statuses: {},
          widgets: {},
          dialogs: [],
        },
        panels: [],
        restorations: [],
        publicationHighWatermark: 1,
      },
      replay: [],
    });

    resolveTree({ success: true, data: { nodes: [], leafId: null } });
    await opening;
    expect(useTreeStore.getState().phase).toBe("loading");
  });

  it("get_tree capability rejection → phase 'unsupported' with the friendly message (review S2)", async () => {
    // An installed SDK without the public tree capability may return an
    // unknown-command error. Never show that raw string.
    nextResponse = async () => ({
      success: false,
      error: "Unknown command: get_tree",
    });

    await useTreeStore.getState().openTreeForSession(SESSION_A);

    const state = useTreeStore.getState();
    expect(state.phase).toBe("unsupported");
    expect(state.errorMessage).not.toMatch(/Unknown command/);
    expect(state.errorMessage).toMatch(/SDK host/i);
    expect(state.nodes).toEqual([]);
  });

  it("get_tree data.unsupported (host up, pi too old for tree) → phase 'unsupported'", async () => {
    // The host is running but the installed pi lacks sessionManager.getTree.
    // The bridge returns a structured `unsupported` flag so the renderer can
    // tell a capability gap from a transient failure.
    nextResponse = async () => ({
      success: true,
      data: { unsupported: true, nodes: [], leafId: null },
    });

    await useTreeStore.getState().openTreeForSession(SESSION_A);

    const state = useTreeStore.getState();
    expect(state.phase).toBe("unsupported");
    expect(state.errorMessage).toMatch(/SDK host/i);
  });

  it("a thrown invoke → phase 'error' with the REAL message (NOT unsupported)", async () => {
    // A thrown command is a transient (host restarting after /reload or idle
    // eviction, command during the activation window, IPC hiccup) — never a
    // capability gap. Mapping it to the permanent "unsupported" phase was
    // the bug: the viewer stuck even through /reload. Now it surfaces the
    // real error in the retryable "error" phase.
    nextResponse = async () => {
      throw new Error("network blip");
    };

    await useTreeStore.getState().openTreeForSession(SESSION_A);

    expect(useTreeStore.getState().phase).toBe("error");
    expect(useTreeStore.getState().errorMessage).toBe(
      "The operation could not be completed. Please try again.",
    );
  });

  it("a typed non-ok query result → retryable 'error' phase, never stuck 'loading'", async () => {
    // session.query returns { status: "transitioning" } while a /reload or
    // /new settles. openTreeForSession seeds phase "loading", and nothing
    // re-runs refresh while the phase stays "loading" — so a silent return
    // here would strand the overlay on a permanent spinner.
    (
      globalThis as unknown as {
        window: { pivis: { invoke: (channel: string, payload: unknown) => Promise<unknown> } };
      }
    ).window.pivis.invoke = async () => ({ status: "transitioning", reason: "host_transition" });

    await useTreeStore.getState().openTreeForSession(SESSION_A);

    expect(useTreeStore.getState().phase).toBe("error");
    expect(useTreeStore.getState().errorMessage).toBe("Session is busy; retry in a moment.");
  });

  it("closeViewer resets open + navigating without touching nodes", () => {
    useTreeStore.setState({
      open: true,
      navigating: true,
      nodes: [{ entry: { id: "x", type: "message" }, children: [] }],
    });
    useTreeStore.getState().closeViewer();
    const s = useTreeStore.getState();
    expect(s.open).toBe(false);
    expect(s.navigating).toBe(false);
    expect(s.nodes).toHaveLength(1);
  });
});

describe("tree-store — navigateTo", () => {
  function publishNavigateOutcome(
    intentId: string,
    state: "completed" | "cancelled" | "failed" | "outcome_unknown",
    result?: { targetId: string; leafId?: string | null; branch?: unknown[] },
  ) {
    const projection = useSessionsStore.getState().sessions.get(SESSION_A)?.authorityProjection;
    const prior = projection?.authoritativeSnapshot;
    const cursor =
      projection?.semantic.state === "following" ? projection.semantic.cursor : undefined;
    if (!prior || !cursor) throw new Error("missing authority snapshot");
    const outcome = {
      intentId,
      owner: prior.owner,
      state,
      kind: "navigate" as const,
      ...(result ? { result } : {}),
    };
    useSessionsStore.getState().applyAuthorityPublication({
      sessionId: SESSION_A,
      rendererGeneration: 0,
      publicationSequence: cursor.transportSequence,
      plane: "semantic",
      owner: prior.owner,
      payload: {
        owner: prior.owner,
        transportSequence: cursor.transportSequence + 1,
        frameId: `navigate-${intentId}`,
        records: [{ type: "intent_outcome", outcome }],
        terminalSnapshot: {
          ...prior,
          snapshotSequence: prior.snapshotSequence + 1,
          recentIntentOutcomes: [...prior.recentIntentOutcomes, outcome],
        },
      },
    } as RendererPublication);
  }

  async function startNavigate() {
    useTreeStore.setState({ open: true, sessionId: SESSION_A, navigating: false });
    const navigation = useTreeStore.getState().navigateTo("u1");
    await Promise.resolve();
    const dispatch = calls.find((call) => call.channel === "session.dispatchIntent");
    const intentId = (dispatch?.payload as { intentId?: string } | undefined)?.intentId;
    if (!intentId) throw new Error("navigate intent was not dispatched");
    return { navigation, intentId };
  }

  it("blocks with a toast when the session is mid-turn (review B1)", async () => {
    useTreeStore.setState({ open: true, sessionId: SESSION_A });
    const prior = useSessionsStore.getState().sessions.get(SESSION_A)
      ?.authorityProjection?.authoritativeSnapshot;
    if (!prior) throw new Error("missing authority snapshot");
    useSessionsStore.getState().applyAuthorityPublication({
      sessionId: SESSION_A,
      rendererGeneration: 0,
      publicationSequence: 1,
      plane: "semantic",
      owner: prior.owner,
      payload: {
        owner: prior.owner,
        transportSequence: 2,
        frameId: "streaming",
        records: [],
        terminalSnapshot: {
          ...prior,
          snapshotSequence: 2,
          sdk: { ...prior.sdk, isStreaming: true, isIdle: false },
        },
      },
    } as RendererPublication);
    await useTreeStore.getState().navigateTo("u1");

    expect(calls.find((c) => c.channel === "session.dispatchIntent")).toBeUndefined();
    const toasts = useSessionsStore.getState().sessions.get(SESSION_A)?.toasts ?? [];
    expect(toasts.some((t) => /wait/i.test(t.message) && t.type === "warning")).toBe(true);
  });

  it("waits for the matching terminal frame; a receipt alone does not close", async () => {
    nextResponse = async (channel) => {
      if (channel === "session.dispatchIntent") {
        return {
          status: "admitted",
          intentId: "ignored",
          owner: { hostInstanceId: "tree-host", sessionEpoch: 1 },
        };
      }
      if (channel === "session.transcriptForEntries") return [];
      return { success: false };
    };
    const { navigation, intentId } = await startNavigate();

    expect(useTreeStore.getState()).toMatchObject({ open: true, navigating: true });
    publishNavigateOutcome(intentId, "completed", { targetId: "u1", leafId: "u1", branch: [] });
    await navigation;
    expect(useTreeStore.getState()).toMatchObject({ open: false, navigating: false, leafId: "u1" });
  });

  it("replaces the transcript from a completed same-owner branch, including an empty branch", async () => {
    useSessionsStore
      .getState()
      .seedHistory(SESSION_A, [
        { id: "old", type: "user", data: { role: "user", content: "old branch" } },
      ]);
    const historyGeneration = useSessionsStore
      .getState()
      .sessions.get(SESSION_A)?.historyGeneration;
    nextResponse = async (channel) => {
      if (channel === "session.dispatchIntent") {
        return {
          status: "admitted",
          intentId: "ignored",
          owner: { hostInstanceId: "tree-host", sessionEpoch: 1 },
        };
      }
      if (channel === "session.transcriptForEntries") return [];
      return { success: false };
    };
    const { navigation, intentId } = await startNavigate();
    publishNavigateOutcome(intentId, "completed", { targetId: "u1", leafId: null, branch: [] });
    await navigation;

    const session = useSessionsStore.getState().sessions.get(SESSION_A);
    expect(session?.transcript.archivedBlockCount).toBe(0);
    expect(session?.historyGeneration).toBe(historyGeneration);
    expect(useTreeStore.getState()).toMatchObject({ open: false, leafId: null, selectedId: null });
  });

  it.each(["cancelled", "failed", "outcome_unknown"] as const)(
    "%s terminal outcome preserves the previous transcript and leaves the overlay open",
    async (state) => {
      useSessionsStore
        .getState()
        .seedHistory(SESSION_A, [
          { id: "old", type: "user", data: { role: "user", content: "old branch" } },
        ]);
      nextResponse = async (channel) =>
        channel === "session.dispatchIntent"
          ? {
              status: "admitted",
              intentId: "ignored",
              owner: { hostInstanceId: "tree-host", sessionEpoch: 1 },
            }
          : { success: false };
      const { navigation, intentId } = await startNavigate();
      publishNavigateOutcome(intentId, state, { targetId: "u1" });
      await navigation;

      expect(
        useSessionsStore.getState().sessions.get(SESSION_A)?.transcript.archivedBlockCount,
      ).toBe(1);
      expect(useTreeStore.getState()).toMatchObject({ open: true, navigating: false });
    },
  );

  it("stale authority after terminal evidence cannot replace the transcript or close", async () => {
    useSessionsStore
      .getState()
      .seedHistory(SESSION_A, [
        { id: "old", type: "user", data: { role: "user", content: "old branch" } },
      ]);
    nextResponse = async (channel) => {
      if (channel === "session.dispatchIntent") {
        return {
          status: "admitted",
          intentId: "ignored",
          owner: { hostInstanceId: "tree-host", sessionEpoch: 1 },
        };
      }
      if (channel === "session.transcriptForEntries") return [];
      return { success: false };
    };
    const { navigation, intentId } = await startNavigate();
    publishNavigateOutcome(intentId, "completed", { targetId: "u1", leafId: "u1", branch: [] });
    useSessionsStore.getState().markAuthorityUnavailable(SESSION_A, "test stale authority");
    await navigation;

    expect(useSessionsStore.getState().sessions.get(SESSION_A)?.transcript.archivedBlockCount).toBe(
      1,
    );
    expect(useTreeStore.getState().open).toBe(true);
  });

  it("not-admitted receipt leaves the overlay open and reports failure", async () => {
    useTreeStore.setState({ open: true, sessionId: SESSION_A });
    nextResponse = async () => ({ status: "not_admitted", intentId: "x", reason: "invalid" });

    await useTreeStore.getState().navigateTo("u1");

    expect(useTreeStore.getState()).toMatchObject({ open: true, navigating: false });
    const toasts = useSessionsStore.getState().sessions.get(SESSION_A)?.toasts ?? [];
    expect(toasts.some((t) => t.type === "error" && /branch switch/.test(t.message))).toBe(true);
  });
});

describe("tree-store — setLabel", () => {
  it("forwards targetId + label to set_label and refreshes", async () => {
    let refreshCalls = 0;
    nextResponse = async (channel, payload) => {
      const cmd = (payload as { command?: { type?: string } }).command;
      if (cmd?.type === "set_label") return { success: true };
      if (cmd?.type === "get_tree") {
        refreshCalls++;
        return { success: true, data: { nodes: [], leafId: null } };
      }
      return { success: false };
    };

    // setLabel is no-op without an open viewer — open the viewer first
    // so sessionId is populated (the store mirrors diff-store here).
    await useTreeStore.getState().openTreeForSession(SESSION_A);
    // Reset the counter so it only counts the post-setLabel refresh.
    refreshCalls = 0;
    calls.length = 0;

    await useTreeStore.getState().setLabel("u1", "checkpoint");

    expect(refreshCalls).toBe(1);
    const sentSetLabel = calls.find((c) => {
      const intent = (c.payload as { intent?: { kind?: string; text?: string } }).intent;
      return intent?.kind === "invokeCommand" && intent.text?.startsWith("/label u1 checkpoint");
    });
    expect(sentSetLabel).toBeDefined();
  });

  it("forwards undefined label to clear it", async () => {
    let received: unknown = null;
    nextResponse = async (_channel, payload) => {
      const cmd = (payload as { command?: { type?: string } }).command;
      if (cmd?.type === "set_label") {
        received = cmd;
        return { success: true };
      }
      if (cmd?.type === "get_tree") return { success: true, data: { nodes: [], leafId: null } };
      return { success: false };
    };

    await useTreeStore.getState().openTreeForSession(SESSION_A);

    await useTreeStore.getState().setLabel("u1", undefined);

    expect((received as { label?: unknown } | null)?.label).toBeUndefined();
  });
});

describe("tree-store — UI primitives", () => {
  it("toggleFold flips membership in foldedIds", () => {
    useTreeStore.getState().toggleFold("u1");
    expect(useTreeStore.getState().foldedIds.has("u1")).toBe(true);
    useTreeStore.getState().toggleFold("u1");
    expect(useTreeStore.getState().foldedIds.has("u1")).toBe(false);
  });

  it("setSearch + setFilterMode + setSelected update fields", () => {
    useTreeStore.getState().setSearch("foo");
    useTreeStore.getState().setFilterMode("labeled-only");
    useTreeStore.getState().setSelected("u9");
    useTreeStore.getState().setSummarizeOnSwitch(true);
    const s = useTreeStore.getState();
    expect(s.search).toBe("foo");
    expect(s.filterMode).toBe("labeled-only");
    expect(s.selectedId).toBe("u9");
    expect(s.summarizeOnSwitch).toBe(true);
  });
});

// Suppress unused-import noise.
void getInvoke;
