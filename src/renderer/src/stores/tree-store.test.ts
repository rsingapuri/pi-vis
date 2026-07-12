import type { SessionId } from "@shared/ids.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSessionsStore } from "./sessions-store.js";
import { allTranscriptBlocks } from "./transcript.js";
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

function mockInvoke(channel: string, payload: unknown): Promise<unknown> {
  calls.push({ channel, payload });
  if (nextResponse) {
    return nextResponse(channel, payload);
  }
  return Promise.resolve({ success: false, error: "no mock" });
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
      if (channel === "session.sendCommand") {
        return { success: true, data: { nodes: flat, leafId: "u2" } };
      }
      return { success: false };
    };
    // Mark the session as a real (non-pending) session, then clear the visible
    // branch to mirror `/tree` selecting the root before any messages.
    useSessionsStore.getState().addUserMessage(SESSION_A, "real session");
    useSessionsStore.getState().seedHistory(SESSION_A, { blocks: [], startIndex: 0, total: 0 });

    await useTreeStore.getState().openTreeForSession(SESSION_A);

    const state = useTreeStore.getState();
    expect(state.open).toBe(true);
    expect(state.sessionId).toBe(SESSION_A);
    expect(state.phase).toBe("ready");
    expect(state.nodes).toEqual(nested);
    expect(state.leafId).toBe("u2");
    expect(state.selectedId).toBe("u2");
    expect(useSessionsStore.getState().sessions.get(SESSION_A)?.hasTreeHistory).toBe(true);

    expect(calls[0]).toEqual({
      channel: "session.sendCommand",
      payload: expect.objectContaining({
        sessionId: SESSION_A,
        command: { type: "get_tree" },
        expectedHostInstanceId: "tree-host",
        expectedSessionEpoch: 1,
      }),
    });
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
    expect(useTreeStore.getState().errorMessage).toBe("network blip");
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
  it("blocks with a toast when the session is mid-turn (review B1)", async () => {
    // Open the viewer first so tree-store.sessionId is populated; then
    // mark the session as mid-turn and verify the navigate_tree command
    // never goes out and a warning toast surfaces.
    nextResponse = async (_channel, payload) => {
      const cmd = (payload as { command?: { type?: string } }).command;
      if (cmd?.type === "get_tree") return { success: true, data: { nodes: [], leafId: null } };
      return { success: false };
    };
    await useTreeStore.getState().openTreeForSession(SESSION_A);
    calls.length = 0;

    useSessionsStore.getState().applyRuntimeState(SESSION_A, {
      availability: "available",
      hostInstanceId: "host-tree",
      sessionEpoch: 1,
      receivedAt: Date.now(),
      snapshot: {
        hostInstanceId: "host-tree",
        sessionEpoch: 1,
        snapshotSequence: 1,
        capturedAt: Date.now(),
        isStreaming: true,
        isIdle: false,
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

    await useTreeStore.getState().navigateTo("u1");

    // No navigate_tree command was sent.
    expect(calls.find((c) => c.channel === "session.sendCommand")).toBeUndefined();

    const toasts = useSessionsStore.getState().sessions.get(SESSION_A)?.toasts ?? [];
    expect(toasts.length).toBeGreaterThan(0);
    expect(toasts.some((t) => /wait/i.test(t.message) && t.type === "warning")).toBe(true);
  });

  it("success path: seeds transcript, injects editorText, refreshes stats, closes overlay", async () => {
    const branch = [
      {
        id: "u1",
        type: "message",
        timestamp: "t1",
        message: { role: "user", content: "the first message" },
      },
    ];
    let sentNavigate = false;
    nextResponse = async (channel, payload) => {
      const cmd = (payload as { command?: { type?: string } }).command;
      if (cmd?.type === "get_tree") {
        // Initial open — return a tiny tree with the target.
        return { success: true, data: { nodes: [], leafId: "u1" } };
      }
      if (cmd?.type === "navigate_tree") {
        sentNavigate = true;
        return {
          success: true,
          data: {
            cancelled: false,
            editorText: "the first message",
            leafId: "u1",
            branch,
          },
        };
      }
      if (cmd?.type === "get_session_stats") {
        return {
          success: true,
          data: {
            sessionId: SESSION_A,
            tokens: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, total: 3 },
            cost: 0.001,
          },
        };
      }
      if (channel === "session.transcriptForEntries") {
        return [{ id: "u1", type: "user", data: { role: "user", content: "the first message" } }];
      }
      return { success: false };
    };

    // Open the viewer so sessionId is populated, then drop the open-time
    // get_tree call from the captured `calls`.
    await useTreeStore.getState().openTreeForSession(SESSION_A);
    calls.length = 0;

    await useTreeStore.getState().navigateTo("u1");

    expect(sentNavigate).toBe(true);
    // seedHistory applied — has a user block.
    const transcript = useSessionsStore.getState().sessions.get(SESSION_A)?.transcript;
    expect(transcript && allTranscriptBlocks(transcript).some((b) => b.type === "user")).toBe(true);

    // editorText injected.
    expect(useSessionsStore.getState().sessions.get(SESSION_A)?.editorInjection?.text).toBe(
      "the first message",
    );

    // stats refreshed.
    const stats = useSessionsStore.getState().sessions.get(SESSION_A)?.stats;
    expect(stats?.tokens?.input).toBe(1);

    // overlay closed.
    expect(useTreeStore.getState().open).toBe(false);
    expect(useTreeStore.getState().navigating).toBe(false);
  });

  it("success path: empty branch + null leafId yields an empty transcript (review S3)", async () => {
    nextResponse = async (_channel, payload) => {
      const cmd = (payload as { command?: { type?: string } }).command;
      if (cmd?.type === "navigate_tree") {
        return { success: true, data: { cancelled: false, leafId: null, branch: [] } };
      }
      if (_channel === "session.transcriptForEntries") {
        return [];
      }
      return { success: false };
    };

    await useTreeStore.getState().navigateTo("u1");

    const blocks = useSessionsStore.getState().sessions.get(SESSION_A)?.transcript.blocks ?? [];
    expect(blocks).toEqual([]);
    expect(useTreeStore.getState().open).toBe(false);
  });

  it("cancelled keeps the overlay open and toasts info", async () => {
    useTreeStore.setState({ open: true, sessionId: SESSION_A });
    nextResponse = async () => ({
      success: true,
      data: { cancelled: true },
    });

    await useTreeStore.getState().navigateTo("u1");

    expect(useTreeStore.getState().open).toBe(true);
    expect(useTreeStore.getState().navigating).toBe(false);
    const toasts = useSessionsStore.getState().sessions.get(SESSION_A)?.toasts ?? [];
    expect(toasts.some((t) => t.type === "info")).toBe(true);
  });

  it("aborted keeps the overlay open", async () => {
    useTreeStore.setState({ open: true, sessionId: SESSION_A });
    nextResponse = async () => ({ success: true, data: { cancelled: false, aborted: true } });

    await useTreeStore.getState().navigateTo("u1");

    expect(useTreeStore.getState().open).toBe(true);
    expect(useTreeStore.getState().navigating).toBe(false);
  });

  it("failed RPC leaves the overlay open and toasts error", async () => {
    useTreeStore.setState({ open: true, sessionId: SESSION_A });
    nextResponse = async () => ({ success: false, error: "boom" });

    await useTreeStore.getState().navigateTo("u1");

    expect(useTreeStore.getState().open).toBe(true);
    expect(useTreeStore.getState().navigating).toBe(false);
    const toasts = useSessionsStore.getState().sessions.get(SESSION_A)?.toasts ?? [];
    expect(toasts.some((t) => t.type === "error" && /boom/.test(t.message))).toBe(true);
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
      const cmd = (c.payload as { command?: { type?: string } }).command;
      return cmd?.type === "set_label";
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
