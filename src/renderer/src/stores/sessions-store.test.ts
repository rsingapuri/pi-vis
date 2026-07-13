import type { SessionId } from "@shared/ids.js";
import { ExtensionUiRequestSchema } from "@shared/pi-protocol/extension-ui.js";
import type { ModelInfo } from "@shared/pi-protocol/responses.js";
import type {
  AgentSessionSnapshot,
  AuthorityAttachResponse,
  AuthorityRecord,
  IntentEnvelope,
  IntentOutcome,
  RendererPublication,
  RuntimeStateUpdate,
  SemanticSnapshot,
} from "@shared/pi-protocol/runtime-state.js";
import type { SessionSearchOpenResult } from "@shared/session-search.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildDiffModel } from "../lib/diff/diff-model.js";
import { nextPanelInputSequence } from "../lib/panel-input-sequence.js";
import {
  isNewSessionPending,
  isPendingNewSessionActiveFor,
  isSessionAbortable,
  isSessionWorking,
  sessionHasHistory,
  shouldShowWorkingIndicator,
  useSessionsStore,
} from "./sessions-store.js";
import { useSettingsStore } from "./settings-store.js";
import { allTranscriptBlocks } from "./transcript.js";

const SESSION_A = "session-a" as SessionId;
const SESSION_B = "session-b" as SessionId;
const SESSION_C = "session-c" as SessionId;
const WORKSPACE = "/tmp/test-workspace";
const PANEL_HOST_A = "11111111-1111-4111-8111-111111111111";
const PANEL_HOST_B = "22222222-2222-4222-8222-222222222222";
const nextPanelSequence = (panelId: number, hostInstanceId = PANEL_HOST_A) =>
  nextPanelInputSequence(SESSION_A, hostInstanceId, 0, panelId);
function installLiveCreateSession(): () => void {
  const original = useSessionsStore.getState().createSession;
  useSessionsStore.setState({
    createSession: (...args: Parameters<typeof original>) => {
      original(...args);
      const sessionId = args[0];
      useSessionsStore.getState().setSessionStatus(sessionId, "ready");
      useSessionsStore.getState().applyRuntimeState(sessionId, runtimeState(false));
    },
  });
  return () => useSessionsStore.setState({ createSession: original });
}

function claimedUnified() {
  return { claimed: true as const, claimId: "claim-test", expiresAt: Date.now() + 60_000 };
}

/** Install a complete semantic baseline: compatibility snapshots are diagnostics only. */
function installAuthority(sessionId = SESSION_A, snapshot = semanticSnapshot(1)): void {
  // Transport availability is independent from semantic authority; a valid
  // baseline is usable only while its host transport is available.
  useSessionsStore.getState().applyRuntimeState(sessionId, runtimeState(false));
  const attach = authorityAttach(snapshot);
  attach.baseline.sessionId = sessionId;
  useSessionsStore.getState().applyAuthorityAttach(sessionId, attach);
  useSessionsStore.getState().setSessionStatus(sessionId, "ready");
}

function publishSemantic(
  sessionId: SessionId,
  transportSequence: number,
  snapshot: SemanticSnapshot,
  records: AuthorityRecord[] = [],
): void {
  useSessionsStore
    .getState()
    .applyAuthorityPublication(
      semanticPublication(transportSequence, snapshot, records, sessionId),
    );
}

function publishIntentOutcome(envelope: IntentEnvelope): void {
  const sessionId = envelope.sessionId as SessionId;
  const projection = useSessionsStore.getState().sessions.get(sessionId)?.authorityProjection;
  const prior = projection?.authoritativeSnapshot;
  const cursor = projection?.semantic.state === "following" ? projection.semantic.cursor : undefined;
  if (!prior || !cursor) throw new Error("intent outcome requires following authority");
  const base = {
    intentId: envelope.intentId,
    owner: envelope.expectedOwner,
    state: "completed" as const,
  };
  let outcome: IntentOutcome;
  switch (envelope.intent.kind) {
    case "submit":
      outcome = {
        ...base,
        kind: "submit",
        result: { disposition: "completed", editorRevision: envelope.intent.editorRevision },
      };
      break;
    case "invokeCommand":
      outcome = { ...base, kind: "invokeCommand", result: {} };
      break;
    case "runBash":
      outcome = { ...base, kind: "runBash", result: { started: true } };
      break;
    default:
      outcome = { ...base, kind: envelope.intent.kind } as IntentOutcome;
  }
  const currentAttachments =
    useSessionsStore.getState().sessions.get(sessionId)?.editorAttachments ?? prior.editor.attachments;
  const snapshot = {
    ...prior,
    snapshotSequence: prior.snapshotSequence + 1,
    editor: { ...prior.editor, attachments: currentAttachments },
    recentIntentOutcomes: [...prior.recentIntentOutcomes, outcome],
  };
  publishSemantic(sessionId, cursor.transportSequence + 1, snapshot, [
    { type: "intent_outcome", outcome },
  ]);
}

function loadedHistory(payload: unknown, history: unknown[]) {
  return {
    status: "loaded" as const,
    historyGeneration: (payload as { historyGeneration: number }).historyGeneration,
    history,
  };
}

function runtimeState(
  isStreaming: boolean,
  sequence = 1,
  availability: RuntimeStateUpdate["availability"] = "available",
): RuntimeStateUpdate {
  const snapshot: AgentSessionSnapshot | undefined =
    availability === "available"
      ? {
          hostInstanceId: "host-1",
          sessionEpoch: 1,
          snapshotSequence: sequence,
          capturedAt: Date.now(),
          isStreaming,
          isIdle: !isStreaming,
          isCompacting: false,
          isRetrying: false,
          retryAttempt: 0,
          isBashRunning: false,
          model: null,
          thinkingLevel: "off",
          sessionId: "wire",
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
        }
      : undefined;
  return {
    availability,
    hostInstanceId: "host-1",
    sessionEpoch: 1,
    receivedAt: Date.now(),
    ...(snapshot ? { snapshot } : {}),
  };
}

describe("sessions store - diff comments", () => {
  beforeEach(() => {
    useSessionsStore.setState({
      sessions: new Map(),
      activeSessionId: null,
      workspaces: new Map(),
      activeWorkspacePath: null,
      diffComments: new Map(),
    });
    useSessionsStore.getState().createSession(SESSION_A, WORKSPACE);
  });

  it("clears only the submitted comment snapshot", () => {
    const store = useSessionsStore.getState();
    store.setDiffComment(SESSION_A, {
      filePath: "a.ts",
      lineNumber: 10,
      lineText: "line 10",
      text: "first",
    });
    store.setDiffComment(SESSION_A, {
      filePath: "a.ts",
      lineNumber: 20,
      lineText: "line 20",
      text: "second",
    });
    const submitted = store.getDiffCommentsForPrompt(SESSION_A);

    store.setDiffComment(SESSION_A, {
      filePath: "a.ts",
      lineNumber: 20,
      lineText: "line 20 edited",
      text: "edited later",
    });
    store.setDiffComment(SESSION_A, {
      filePath: "b.ts",
      lineNumber: 1,
      lineText: "line 1",
      text: "new later",
    });
    store.clearSubmittedDiffComments(SESSION_A, submitted);

    const remaining = useSessionsStore.getState().getDiffCommentsForPrompt(SESSION_A);
    expect(remaining.map((c) => `${c.filePath}:${c.lineNumber}:${c.text}`).sort()).toEqual([
      "a.ts:20:edited later",
      "b.ts:1:new later",
    ]);
  });

  it("relocates an anchor when its saved line text moves uniquely", () => {
    const store = useSessionsStore.getState();
    store.setDiffComment(SESSION_A, {
      filePath: "a.ts",
      lineNumber: 2,
      lineText: "target();",
      text: "This should follow the line.",
    });
    const model = buildDiffModel(
      "alpha();\ntarget();\nomega();\n",
      "intro();\nalpha();\ntarget();\nomega();\n",
    );
    if (model.kind !== "ok") throw new Error("expected ok model");

    store.reconcileDiffCommentsForFile(SESSION_A, "a.ts", model);

    const comments = useSessionsStore.getState().getDiffCommentsForPrompt(SESSION_A);
    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({
      lineNumber: 3,
      originalLineNumber: 2,
      anchorStatus: "relocated",
    });
  });

  it("marks an anchor stale when its saved line text no longer exists uniquely", () => {
    const store = useSessionsStore.getState();
    store.setDiffComment(SESSION_A, {
      filePath: "a.ts",
      lineNumber: 2,
      lineText: "target();",
      text: "This might be stale.",
    });
    const model = buildDiffModel(
      "alpha();\ntarget();\nomega();\n",
      "alpha();\nchanged();\nomega();\n",
    );
    if (model.kind !== "ok") throw new Error("expected ok model");

    store.reconcileDiffCommentsForFile(SESSION_A, "a.ts", model);

    expect(useSessionsStore.getState().getDiffCommentsForPrompt(SESSION_A)[0]).toMatchObject({
      lineNumber: 2,
      anchorStatus: "stale",
    });
  });

  it("marks a blank-line anchor stale when that line is no longer blank", () => {
    const store = useSessionsStore.getState();
    store.setDiffComment(SESSION_A, {
      filePath: "a.ts",
      lineNumber: 2,
      lineText: "",
      text: "This blank separator matters.",
    });
    const model = buildDiffModel("alpha();\n\nomega();\n", "alpha();\nchanged();\nomega();\n");
    if (model.kind !== "ok") throw new Error("expected ok model");

    store.reconcileDiffCommentsForFile(SESSION_A, "a.ts", model);

    expect(useSessionsStore.getState().getDiffCommentsForPrompt(SESSION_A)[0]).toMatchObject({
      lineNumber: 2,
      anchorStatus: "stale",
    });
  });

  it("marks comments stale when their file disappears from the diff", () => {
    const store = useSessionsStore.getState();
    store.setDiffComment(SESSION_A, {
      filePath: "a.ts",
      lineNumber: 2,
      lineText: "target();",
      text: "This file was reverted.",
    });
    store.setDiffComment(SESSION_A, {
      filePath: "b.ts",
      lineNumber: 1,
      lineText: "still changed",
      text: "This file is still visible.",
    });

    store.markDiffCommentsStaleForMissingFiles(SESSION_A, new Set(["b.ts"]));

    const byFile = new Map(
      useSessionsStore
        .getState()
        .getDiffCommentsForPrompt(SESSION_A)
        .map((c) => [c.filePath, c]),
    );
    expect(byFile.get("a.ts")).toMatchObject({ anchorStatus: "stale" });
    expect(byFile.get("b.ts")).toMatchObject({ anchorStatus: "current" });
  });

  it("keeps an existing anchor when a relocated comment would collide with it", () => {
    const store = useSessionsStore.getState();
    store.setDiffComment(SESSION_A, {
      filePath: "a.ts",
      lineNumber: 2,
      lineText: "target();",
      text: "This one cannot move onto an occupied line.",
    });
    store.setDiffComment(SESSION_A, {
      filePath: "a.ts",
      lineNumber: 3,
      lineText: "target();",
      text: "Keep this line's own comment.",
    });
    const model = buildDiffModel(
      "alpha();\ntarget();\nspacer();\n",
      "alpha();\nchanged();\ntarget();\n",
    );
    if (model.kind !== "ok") throw new Error("expected ok model");

    store.reconcileDiffCommentsForFile(SESSION_A, "a.ts", model);

    const byLine = new Map(
      useSessionsStore
        .getState()
        .getDiffCommentsForPrompt(SESSION_A)
        .map((c) => [c.lineNumber, c]),
    );
    expect(byLine.get(2)).toMatchObject({
      text: "This one cannot move onto an occupied line.",
      anchorStatus: "stale",
    });
    expect(byLine.get(3)).toMatchObject({
      text: "Keep this line's own comment.",
      anchorStatus: "current",
    });
  });

  it("preserves pending diff comments when a live session tab is closed", () => {
    const store = useSessionsStore.getState();
    store.setDiffComment(SESSION_A, {
      filePath: "a.ts",
      lineNumber: 2,
      lineText: "target();",
      text: "Keep this for resume.",
    });

    store.removeSession(SESSION_A);

    expect(useSessionsStore.getState().getDiffCommentsForPrompt(SESSION_A)[0]).toMatchObject({
      text: "Keep this for resume.",
    });
  });

  it("reattaches pending diff comments when a closed session file is reopened", async () => {
    const sessionFile = "/tmp/session-a.jsonl";
    const originalWindow = (globalThis as { window?: unknown }).window;
    const invokeMock = vi.fn(async (channel: string, payload?: unknown) => {
      if (channel === "session.open") {
        return {
          outcome: "opened",
          sessionId: SESSION_B,
          name: "Session A",
          preview: "Preview",
          sessionStatus: "cold",
        };
      }
      if (channel === "session.loadHistory") {
        return loadedHistory(payload, []);
      }
      throw new Error(`unexpected channel ${channel}`);
    });
    (globalThis as { window: unknown }).window = { pivis: { invoke: invokeMock } };
    try {
      useSessionsStore.getState().createSession(SESSION_A, WORKSPACE, sessionFile);
      useSessionsStore.getState().setDiffComment(SESSION_A, {
        filePath: "a.ts",
        lineNumber: 2,
        lineText: "target();",
        text: "Keep this for resume.",
      });
      useSessionsStore.getState().removeSession(SESSION_A);

      await useSessionsStore.getState().openSessionTab(WORKSPACE, sessionFile);

      expect(useSessionsStore.getState().getDiffCommentsForPrompt(SESSION_B)[0]).toMatchObject({
        text: "Keep this for resume.",
      });
    } finally {
      if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window;
      else (globalThis as { window: unknown }).window = originalWindow;
    }
  });
});

/**
 * These tests pin the invariant that drives the SessionHeader thinking
 * dropdown: whatever pi reports in a `thinking_level_changed` event (or in
 * the response to a `get_state` call, propagated via the same store
 * field) is exactly what the dropdown renders. The UI is a pure function
 * of `state.sessions.get(sessionId).thinkingLevel`.
 */
describe("sessions store - thinking level invariant", () => {
  beforeEach(() => {
    // Reset by replacing the whole store with a fresh one.
    useSessionsStore.setState({
      sessions: new Map(),
      activeSessionId: null,
      workspaces: new Map(),
      activeWorkspacePath: null,
    });
    useSessionsStore.getState().createSession(SESSION_A, WORKSPACE);
    useSessionsStore.getState().createSession(SESSION_B, WORKSPACE);
  });

  it("defaults to no thinking level for a new session", () => {
    const session = useSessionsStore.getState().sessions.get(SESSION_A);
    expect(session?.thinkingLevel).toBeUndefined();
  });

  it("projects the thinking level from its terminal authority frame", () => {
    installAuthority(SESSION_A);
    useSessionsStore.getState().setThinkingLevel(SESSION_A, "high");
    // Compatibility setters/receipts cannot select a canonical value.
    expect(useSessionsStore.getState().sessions.get(SESSION_A)?.thinkingLevel).toBe("low");
    publishSemantic(SESSION_A, 2, semanticSnapshot(2, { thinkingLevel: "high" }));
    expect(useSessionsStore.getState().sessions.get(SESSION_A)?.thinkingLevel).toBe("high");
  });

  it("reconciles a clamped level from the terminal authority frame", () => {
    installAuthority(SESSION_A);
    useSessionsStore.getState().applyEvent(SESSION_A, {
      type: "thinking_level_changed",
      level: "xhigh",
    });
    expect(useSessionsStore.getState().sessions.get(SESSION_A)?.thinkingLevel).toBe("low");
    publishSemantic(SESSION_A, 2, semanticSnapshot(2, { thinkingLevel: "high" }));
    expect(useSessionsStore.getState().sessions.get(SESSION_A)?.thinkingLevel).toBe("high");
  });

  it("applyEvent is a no-op for sessions it doesn't know about", () => {
    useSessionsStore.getState().applyEvent("unknown" as SessionId, {
      type: "thinking_level_changed",
      level: "low",
    });
    // The known sessions are untouched.
    expect(useSessionsStore.getState().sessions.get(SESSION_A)?.thinkingLevel).toBeUndefined();
    expect(useSessionsStore.getState().sessions.get(SESSION_B)?.thinkingLevel).toBeUndefined();
  });

  it("scopes authoritative thinking frames to a single session", () => {
    installAuthority(SESSION_A);
    installAuthority(SESSION_B);
    publishSemantic(SESSION_A, 2, semanticSnapshot(2, { thinkingLevel: "high" }));
    publishSemantic(SESSION_B, 2, semanticSnapshot(2, { thinkingLevel: "off" }));
    expect(useSessionsStore.getState().sessions.get(SESSION_A)?.thinkingLevel).toBe("high");
    expect(useSessionsStore.getState().sessions.get(SESSION_B)?.thinkingLevel).toBe("off");
  });

  it("tolerates an authoritative coerced-off value", () => {
    installAuthority(SESSION_A);
    publishSemantic(SESSION_A, 2, semanticSnapshot(2, { thinkingLevel: "off" }));
    expect(useSessionsStore.getState().sessions.get(SESSION_A)?.thinkingLevel).toBe("off");
  });
});

describe("sessions store - session name from pi", () => {
  beforeEach(() => {
    useSessionsStore.setState({
      sessions: new Map(),
      activeSessionId: null,
      workspaces: new Map(),
    });
    useSessionsStore.getState().createSession(SESSION_A, WORKSPACE);
  });

  it("updates sessionName from a completed rename outcome", () => {
    installAuthority();
    const snapshot = semanticSnapshot(2);
    publishSemantic(SESSION_A, 2, snapshot, [
      {
        type: "intent_outcome",
        outcome: {
          intentId: "rename",
          owner: snapshot.owner,
          kind: "rename",
          state: "completed",
          result: { name: "Refactor config loader" },
        },
      },
    ]);
    expect(useSessionsStore.getState().sessions.get(SESSION_A)?.sessionName).toBe(
      "Refactor config loader",
    );
  });

  it("overwrites a prior name with a newer completed rename outcome", () => {
    installAuthority();
    const first = semanticSnapshot(2);
    publishSemantic(SESSION_A, 2, first, [
      {
        type: "intent_outcome",
        outcome: {
          intentId: "old",
          owner: first.owner,
          kind: "rename",
          state: "completed",
          result: { name: "Old name" },
        },
      },
    ]);
    const second = semanticSnapshot(3);
    publishSemantic(SESSION_A, 3, second, [
      {
        type: "intent_outcome",
        outcome: {
          intentId: "new",
          owner: second.owner,
          kind: "rename",
          state: "completed",
          result: { name: "New name" },
        },
      },
    ]);
    expect(useSessionsStore.getState().sessions.get(SESSION_A)?.sessionName).toBe("New name");
  });

  it("clears the name when a successor baseline omits it", () => {
    installAuthority();
    const successor = semanticSnapshot(1, { owner: { hostInstanceId: "host-2", sessionEpoch: 2 } });
    installAuthority(SESSION_A, successor);
    expect(useSessionsStore.getState().sessions.get(SESSION_A)?.sessionName).toBeUndefined();
  });

  it("scopes completed rename outcomes to a single session", () => {
    useSessionsStore.getState().createSession(SESSION_B, WORKSPACE);
    installAuthority(SESSION_A);
    installAuthority(SESSION_B);
    const snapshot = semanticSnapshot(2);
    publishSemantic(SESSION_A, 2, snapshot, [
      {
        type: "intent_outcome",
        outcome: {
          intentId: "a",
          owner: snapshot.owner,
          kind: "rename",
          state: "completed",
          result: { name: "A's name" },
        },
      },
    ]);
    publishSemantic(SESSION_B, 2, snapshot, [
      {
        type: "intent_outcome",
        outcome: {
          intentId: "b",
          owner: snapshot.owner,
          kind: "rename",
          state: "completed",
          result: { name: "B's name" },
        },
      },
    ]);
    expect(useSessionsStore.getState().sessions.get(SESSION_A)?.sessionName).toBe("A's name");
    expect(useSessionsStore.getState().sessions.get(SESSION_B)?.sessionName).toBe("B's name");
  });
});

// Runtime snapshots remain transport diagnostics. Semantic controls are projected only
// from complete, contiguous authority frames.
describe("sessions store - runtime snapshots", () => {
  beforeEach(() => {
    useSessionsStore.setState({
      sessions: new Map(),
      activeSessionId: null,
      workspaces: new Map(),
      activeWorkspacePath: null,
    });
    useSessionsStore.getState().createSession(SESSION_A, WORKSPACE);
    installAuthority();
  });

  it("does not let direct runtime snapshots overwrite a semantic baseline", () => {
    useSessionsStore.getState().applyRuntimeState(SESSION_A, runtimeState(true, 99));
    expect(isSessionWorking(useSessionsStore.getState().sessions.get(SESSION_A))).toBe(false);
    publishSemantic(
      SESSION_A,
      2,
      semanticSnapshot(2, {
        sdk: {
          isStreaming: true,
          isIdle: false,
          isCompacting: false,
          isRetrying: false,
          retryAttempt: 0,
          isBashRunning: false,
        },
      }),
    );
    expect(isSessionWorking(useSessionsStore.getState().sessions.get(SESSION_A))).toBe(true);
  });

  it("orders frames, ignores stale ones, and fences a transport gap rather than guessing", () => {
    publishSemantic(
      SESSION_A,
      2,
      semanticSnapshot(2, {
        sdk: {
          isStreaming: true,
          isIdle: false,
          isCompacting: false,
          isRetrying: false,
          retryAttempt: 0,
          isBashRunning: false,
        },
      }),
    );
    publishSemantic(SESSION_A, 1, semanticSnapshot(1));
    expect(isSessionWorking(useSessionsStore.getState().sessions.get(SESSION_A))).toBe(true);
    publishSemantic(SESSION_A, 4, semanticSnapshot(4));
    const session = useSessionsStore.getState().sessions.get(SESSION_A);
    expect(session?.authorityProjection?.semantic.state).toBe("synchronizing");
    expect(isSessionWorking(session)).toBe(false);
  });

  it("applies availability transport facts without treating them as completed turns", () => {
    useSessionsStore.getState().applyRuntimeState(SESSION_A, runtimeState(false, 1, "unavailable"));
    expect(useSessionsStore.getState().sessions.get(SESSION_A)?.availability).toBe("unavailable");
    expect(useSessionsStore.getState().sessions.get(SESSION_A)?.unreadStatus).toBeUndefined();
  });

  it("projects queues and editor conflict candidates from the same terminal frame", () => {
    publishSemantic(
      SESSION_A,
      2,
      semanticSnapshot(2, {
        queues: {
          steering: ["steer"],
          followUp: ["follow"],
          steeringIntentIds: ["steer-id"],
          followUpIntentIds: ["follow-id"],
        },
        editor: {
          revision: 3,
          text: "authoritative",
          attachments: [],
          conflictText: "local",
          conflictAttachments: [{ kind: "file", name: "draft.txt" }],
        },
      }),
    );
    const session = useSessionsStore.getState().sessions.get(SESSION_A);
    expect(session?.queuedMessages).toMatchObject({
      steering: [{ text: "steer", intentId: "steer-id" }],
      followUp: [{ text: "follow", intentId: "follow-id" }],
    });
    expect(session?.editorConflict).toMatchObject({
      authoritativeText: "authoritative",
      localText: "local",
    });
  });

  it("keeps a queued prompt under exactly one visible owner after its authoritative echo", () => {
    useSessionsStore
      .getState()
      .addUserMessage(SESSION_A, "queued", undefined, { registerEcho: true, intentId: "intent-1" });
    publishSemantic(
      SESSION_A,
      2,
      semanticSnapshot(2, {
        queues: {
          steering: ["queued"],
          followUp: [],
          steeringIntentIds: ["intent-1"],
          followUpIntentIds: [],
        },
      }),
    );
    expect(useSessionsStore.getState().sessions.get(SESSION_A)?.queuedMessages).toBeUndefined();
  });

  it("retains local draft candidates when a successor baseline replaces the host", () => {
    useSessionsStore.getState().setSessionDraft(SESSION_A, "newer local draft");
    const successor = semanticSnapshot(1, {
      owner: { hostInstanceId: "host-2", sessionEpoch: 2 },
      editor: { revision: 1, text: "host draft", attachments: [] },
    });
    installAuthority(SESSION_A, successor);
    expect(useSessionsStore.getState().sessionDrafts.get(SESSION_A)).toBe("newer local draft");
    expect(useSessionsStore.getState().sessions.get(SESSION_A)?.editorInjection?.text).toBe(
      "host draft",
    );
  });
});

describe("createSession(name) and tab lifecycle", () => {
  beforeEach(() => {
    useSessionsStore.setState({
      sessions: new Map(),
      activeSessionId: null,
      workspaces: new Map(),
      activeWorkspacePath: null,
    });
  });

  it("createSession records name + file and does NOT steal focus", () => {
    useSessionsStore.getState().createSession(SESSION_A, WORKSPACE, "/f/a.jsonl", "Named");
    const s = useSessionsStore.getState().sessions.get(SESSION_A);
    expect(s?.sessionName).toBe("Named");
    expect(s?.sessionFile).toBe("/f/a.jsonl");
    expect(useSessionsStore.getState().activeSessionId).toBeNull();
  });

  it("createSession marks resumed sessions (with file) vs new sessions (no file)", () => {
    // New session: no file → resumed=false (last-used model/thinking applies)
    useSessionsStore.getState().createSession(SESSION_A, WORKSPACE);
    expect(useSessionsStore.getState().sessions.get(SESSION_A)?.resumed).toBe(false);
    // Resumed session: opened from a file → resumed=true (keeps its own model)
    useSessionsStore.getState().createSession(SESSION_B, WORKSPACE, "/f/b.jsonl");
    expect(useSessionsStore.getState().sessions.get(SESSION_B)?.resumed).toBe(true);
  });

  it("removeSession removes from sessions and workspace, clears activeSessionId only when pointing at it", () => {
    useSessionsStore.getState().addWorkspace(WORKSPACE);
    useSessionsStore.getState().createSession(SESSION_A, WORKSPACE);
    useSessionsStore.getState().createSession(SESSION_B, WORKSPACE);
    useSessionsStore.getState().setActiveSession(SESSION_A);

    useSessionsStore.getState().removeSession(SESSION_A);
    expect(useSessionsStore.getState().sessions.get(SESSION_A)).toBeUndefined();
    expect(useSessionsStore.getState().activeSessionId).toBeNull();
    // B is still there, and the workspace's activeSessions list no longer mentions A.
    const ws = useSessionsStore.getState().workspaces.get(WORKSPACE);
    expect(ws?.activeSessions).toEqual([SESSION_B]);

    useSessionsStore.getState().setActiveSession(SESSION_B);
    useSessionsStore.getState().removeSession(SESSION_B);
    expect(useSessionsStore.getState().activeSessionId).toBeNull();
  });

  it("createSession sixth arg sets status; omitted arg defaults to cold", () => {
    useSessionsStore
      .getState()
      .createSession(SESSION_A, WORKSPACE, "/f/a.jsonl", undefined, undefined, "ready");
    expect(useSessionsStore.getState().sessions.get(SESSION_A)?.status).toBe("ready");

    useSessionsStore.getState().createSession(SESSION_B, WORKSPACE, "/f/b.jsonl");
    expect(useSessionsStore.getState().sessions.get(SESSION_B)?.status).toBe("cold");
  });

  it("setSessionFile sets once, second call is ignored", () => {
    useSessionsStore.getState().addWorkspace(WORKSPACE);
    useSessionsStore.getState().createSession(SESSION_A, WORKSPACE);
    useSessionsStore.getState().setSessionFile(SESSION_A, "/first.jsonl");
    expect(useSessionsStore.getState().sessions.get(SESSION_A)?.sessionFile).toBe("/first.jsonl");
    useSessionsStore.getState().setSessionFile(SESSION_A, "/second.jsonl");
    expect(useSessionsStore.getState().sessions.get(SESSION_A)?.sessionFile).toBe("/first.jsonl");
  });

  it("computeOpenTabs / persistOpenTabs are no longer exported (tab persistence is gone)", () => {
    // Tab-restore was removed: settings no longer tracks openTabs /
    // activeSessionFile, so the store no longer needs to compute or
    // persist them. This test pins that removal — if either symbol
    // reappears, import resolution fails and the suite is loud.
    expect(
      (useSessionsStore as unknown as Record<string, unknown>)["computeOpenTabs"],
    ).toBeUndefined();
    expect(
      (useSessionsStore as unknown as Record<string, unknown>)["persistOpenTabs"],
    ).toBeUndefined();
  });
});

describe("createSession(title) and addUserMessage self-labeling", () => {
  beforeEach(() => {
    useSessionsStore.setState({
      sessions: new Map(),
      activeSessionId: null,
      workspaces: new Map(),
      activeWorkspacePath: null,
    });
  });

  it("createSession stores title (preview) and leaves sessionName undefined", () => {
    useSessionsStore
      .getState()
      .createSession(SESSION_A, WORKSPACE, "/f/a.jsonl", undefined, "What model is this?");
    const s = useSessionsStore.getState().sessions.get(SESSION_A);
    expect(s?.sessionTitle).toBe("What model is this?");
    expect(s?.sessionName).toBeUndefined();
  });

  it("createSession stores both name and title; consumers prefer name", () => {
    useSessionsStore
      .getState()
      .createSession(SESSION_A, WORKSPACE, "/f/a.jsonl", "Renamed", "preview text");
    const s = useSessionsStore.getState().sessions.get(SESSION_A);
    expect(s?.sessionName).toBe("Renamed");
    expect(s?.sessionTitle).toBe("preview text");
  });

  it("addUserMessage self-labels a brand-new session from the first prompt (single line)", () => {
    useSessionsStore.getState().createSession(SESSION_A, WORKSPACE, "/f/a.jsonl");
    useSessionsStore.getState().addUserMessage(SESSION_A, "hello there");
    expect(useSessionsStore.getState().sessions.get(SESSION_A)?.sessionTitle).toBe("hello there");

    // A second message must not overwrite the first-prompt identity.
    useSessionsStore.getState().addUserMessage(SESSION_A, "goodbye");
    expect(useSessionsStore.getState().sessions.get(SESSION_A)?.sessionTitle).toBe("hello there");
  });

  it("addUserMessage uses the first line of a multi-line prompt", () => {
    useSessionsStore.getState().createSession(SESSION_A, WORKSPACE, "/f/a.jsonl");
    useSessionsStore.getState().addUserMessage(SESSION_A, "fix the parser\nplease");
    expect(useSessionsStore.getState().sessions.get(SESSION_A)?.sessionTitle).toBe(
      "fix the parser",
    );
  });

  it("addUserMessage does NOT overwrite a title set at createSession", () => {
    useSessionsStore
      .getState()
      .createSession(SESSION_A, WORKSPACE, "/f/a.jsonl", undefined, "resume preview");
    useSessionsStore.getState().addUserMessage(SESSION_A, "first prompt");
    expect(useSessionsStore.getState().sessions.get(SESSION_A)?.sessionTitle).toBe(
      "resume preview",
    );
  });

  it("addUserMessage does NOT overwrite an authority-confirmed session name", () => {
    useSessionsStore.getState().createSession(SESSION_A, WORKSPACE, "/f/a.jsonl");
    installAuthority();
    const snapshot = semanticSnapshot(2);
    publishSemantic(SESSION_A, 2, snapshot, [
      {
        type: "intent_outcome",
        outcome: {
          intentId: "rename",
          owner: snapshot.owner,
          kind: "rename",
          state: "completed",
          result: { name: "Renamed by user" },
        },
      },
    ]);
    useSessionsStore.getState().addUserMessage(SESSION_A, "first prompt");
    expect(useSessionsStore.getState().sessions.get(SESSION_A)?.sessionName).toBe(
      "Renamed by user",
    );
    expect(useSessionsStore.getState().sessions.get(SESSION_A)?.sessionTitle).toBeUndefined();
  });
});

/**
 * /plan (and other extensions) clear their on-screen metadata by sending
 * `setStatus` / `setWidget` with the payload field set to `undefined`. Pi's
 * `JSON.stringify` drops undefined values, so the wire frame omits the
 * field entirely. The store's clear-payload handling, paired with the
 * optional schema fields, is what makes `/plan exit` actually remove the
 * widget strip and status segment instead of leaving them on screen.
 */
describe("sessions store - extension UI clear payloads", () => {
  beforeEach(() => {
    useSessionsStore.setState({
      sessions: new Map(),
      activeSessionId: null,
      workspaces: new Map(),
      activeWorkspacePath: null,
    });
    useSessionsStore.getState().createSession(SESSION_A, WORKSPACE, "/f/a.jsonl");
  });

  it("installs and clears status presentation through extension baselines", () => {
    const active = authorityAttach();
    active.baseline.extensionUi.statuses = { plan: "plan active" };
    useSessionsStore.getState().applyAuthorityAttach(SESSION_A, active);
    expect(
      useSessionsStore.getState().sessions.get(SESSION_A)?.authorityProjection?.extensionUiBaseline
        ?.statuses,
    ).toEqual({ plan: "plan active" });
    expect(useSessionsStore.getState().sessions.get(SESSION_A)?.statusSegments.get("plan")).toBe(
      "plan active",
    );

    const cleared = authorityAttach();
    cleared.baseline.publicationHighWatermark = 1;
    useSessionsStore.getState().applyAuthorityAttach(SESSION_A, cleared);
    expect(
      useSessionsStore.getState().sessions.get(SESSION_A)?.authorityProjection?.extensionUiBaseline
        ?.statuses,
    ).toEqual({});
  });

  it("setStatus clearing a non-existent key is a no-op (no throw, no stray entries)", () => {
    useSessionsStore.getState().addUiRequest(SESSION_A, {
      type: "extension_ui_request",
      id: "s3",
      method: "setStatus",
      statusKey: "never-set",
    });
    expect(useSessionsStore.getState().sessions.get(SESSION_A)?.statusSegments.size).toBe(0);
  });

  it("installs and clears widget presentation through extension baselines", () => {
    const active = authorityAttach();
    active.baseline.extensionUi.widgets = {
      plan: ["Plan mode: planning", "Produce a <proposed_plan> block."],
    };
    useSessionsStore.getState().applyAuthorityAttach(SESSION_A, active);
    expect(
      useSessionsStore.getState().sessions.get(SESSION_A)?.authorityProjection?.extensionUiBaseline
        ?.widgets.plan,
    ).toEqual(["Plan mode: planning", "Produce a <proposed_plan> block."]);
    expect(useSessionsStore.getState().sessions.get(SESSION_A)?.widgets.get("plan")).toEqual([
      "Plan mode: planning",
      "Produce a <proposed_plan> block.",
    ]);

    const cleared = authorityAttach();
    cleared.baseline.publicationHighWatermark = 1;
    useSessionsStore.getState().applyAuthorityAttach(SESSION_A, cleared);
    expect(
      useSessionsStore.getState().sessions.get(SESSION_A)?.authorityProjection?.extensionUiBaseline
        ?.widgets,
    ).toEqual({});
  });

  it("setWidget clearing a non-existent key is a no-op (no throw, no stray entries)", () => {
    useSessionsStore.getState().addUiRequest(SESSION_A, {
      type: "extension_ui_request",
      id: "w3",
      method: "setWidget",
      widgetKey: "never-set",
    });
    expect(useSessionsStore.getState().sessions.get(SESSION_A)?.widgets.size).toBe(0);
  });

  it("ExtensionUiRequestSchema accepts setStatus / setWidget with payload field absent (wire-shape regression)", () => {
    // Regression for the /plan-exit bug: the previous schema required
    // statusText / widgetLines, but pi's wire frame omits them entirely
    // (not null — just absent). The schema must parse these lines.
    const statusClear = ExtensionUiRequestSchema.safeParse({
      type: "extension_ui_request",
      id: "1",
      method: "setStatus",
      statusKey: "plan",
    });
    expect(statusClear.success).toBe(true);

    const widgetClear = ExtensionUiRequestSchema.safeParse({
      type: "extension_ui_request",
      id: "2",
      method: "setWidget",
      widgetKey: "plan",
    });
    expect(widgetClear.success).toBe(true);
  });
});

/**
 * Sidebar status-dot unread notifications: a finished turn marks the session
 * "done" (or "error" on a provider failure). The marker persists as a
 * notification for background sessions and is cleared only when the user has
 * viewed the session and moves on, or starts a new turn there.
 */
describe("sessions store - runtime turn-result status", () => {
  beforeEach(() => {
    useSessionsStore.setState({
      sessions: new Map(),
      activeSessionId: null,
      workspaces: new Map(),
      activeWorkspacePath: null,
    });
    useSessionsStore.getState().createSession(SESSION_A, WORKSPACE);
  });

  it("does not settle a turn from a direct runtime transition", () => {
    const store = useSessionsStore.getState();
    store.applyRuntimeState(SESSION_A, runtimeState(true));
    store.applyRuntimeState(SESSION_A, runtimeState(false, 2));
    expect(useSessionsStore.getState().sessions.get(SESSION_A)?.unreadStatus).toBeUndefined();
  });
});

describe("sessions store - workspace expand / reorder model", () => {
  const WS_A = "/tmp/ws-a";
  const WS_B = "/tmp/ws-b";
  const WS_C = "/tmp/ws-c";

  beforeEach(() => {
    useSessionsStore.setState({
      sessions: new Map(),
      activeSessionId: null,
      workspaces: new Map(),
      activeWorkspacePath: null,
      expandedWorkspaces: [],
    });
    useSessionsStore.getState().addWorkspace(WS_A);
    useSessionsStore.getState().addWorkspace(WS_B);
    useSessionsStore.getState().addWorkspace(WS_C);
  });

  it("toggleWorkspaceExpanded adds then removes a path without affecting others", () => {
    const store = useSessionsStore.getState();
    store.toggleWorkspaceExpanded(WS_A);
    store.toggleWorkspaceExpanded(WS_C);
    expect(useSessionsStore.getState().expandedWorkspaces).toEqual([WS_A, WS_C]);
    // Active workspace is untouched by expand toggling.
    expect(useSessionsStore.getState().activeWorkspacePath).toBeNull();
    store.toggleWorkspaceExpanded(WS_A);
    expect(useSessionsStore.getState().expandedWorkspaces).toEqual([WS_C]);
  });

  it("setExpandedWorkspaces replaces the set wholesale", () => {
    useSessionsStore.getState().setExpandedWorkspaces([WS_B]);
    expect(useSessionsStore.getState().expandedWorkspaces).toEqual([WS_B]);
  });

  it("expandWorkspace is idempotent: adds once, never collapses an already-expanded path", () => {
    const store = useSessionsStore.getState();
    store.expandWorkspace(WS_A);
    expect(useSessionsStore.getState().expandedWorkspaces).toEqual([WS_A]);
    // Re-expanding the same path must not toggle it back off.
    store.expandWorkspace(WS_A);
    expect(useSessionsStore.getState().expandedWorkspaces).toEqual([WS_A]);
  });

  it("reorderWorkspaces moves an entry and preserves the rest of the order", () => {
    const store = useSessionsStore.getState();
    store.reorderWorkspaces(0, 2); // A B C -> B C A
    expect(Array.from(useSessionsStore.getState().workspaces.keys())).toEqual([WS_B, WS_C, WS_A]);
    store.reorderWorkspaces(2, 0); // B C A -> A B C
    expect(Array.from(useSessionsStore.getState().workspaces.keys())).toEqual([WS_A, WS_B, WS_C]);
  });

  it("reorderWorkspaces is a no-op for out-of-range or equal indices", () => {
    const before = Array.from(useSessionsStore.getState().workspaces.keys());
    useSessionsStore.getState().reorderWorkspaces(0, 0);
    useSessionsStore.getState().reorderWorkspaces(-1, 1);
    useSessionsStore.getState().reorderWorkspaces(0, 99);
    expect(Array.from(useSessionsStore.getState().workspaces.keys())).toEqual(before);
  });

  it("removeWorkspace clears the entry from both workspaces and expandedWorkspaces", () => {
    const store = useSessionsStore.getState();
    store.toggleWorkspaceExpanded(WS_B);
    store.removeWorkspace(WS_B);
    const s = useSessionsStore.getState();
    expect(Array.from(s.workspaces.keys())).toEqual([WS_A, WS_C]);
    expect(s.expandedWorkspaces).toEqual([]);
  });

  it("setActiveSession derives activeWorkspacePath from the session's workspace", () => {
    const store = useSessionsStore.getState();
    store.createSession(SESSION_A, WS_B);
    store.setActiveSession(SESSION_A);
    expect(useSessionsStore.getState().activeWorkspacePath).toBe(WS_B);
    // Clearing the active session clears the active workspace too.
    store.setActiveSession(null);
    expect(useSessionsStore.getState().activeWorkspacePath).toBeNull();
  });

  it("does not release the previous host when a slow target activation finishes after return", async () => {
    let resolveActivation!: () => void;
    const activation = new Promise<void>((resolve) => {
      resolveActivation = resolve;
    });
    const invoke = vi.fn((channel: string, payload: { sessionId?: SessionId }) => {
      if (channel === "session.activate" && payload.sessionId === SESSION_B) return activation;
      if (channel === "session.releaseActivationVisit") return Promise.resolve({ released: true });
      return Promise.resolve(undefined);
    });
    vi.stubGlobal("window", { pivis: { invoke } });
    const store = useSessionsStore.getState();
    store.createSession(SESSION_A, WS_A, "/f/a.jsonl", undefined, undefined, "ready");
    store.createSession(SESSION_B, WS_B, "/f/b.jsonl", undefined, undefined, "cold");
    useSessionsStore.setState((state) => {
      const sessions = new Map(state.sessions);
      const previous = sessions.get(SESSION_A);
      if (previous) sessions.set(SESSION_A, { ...previous, activationVisitId: "visit-a" });
      return { sessions, activeSessionId: SESSION_A, activeWorkspacePath: WS_A };
    });

    const openTarget = store.setActiveSession(SESSION_B);
    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        "session.activate",
        expect.objectContaining({ sessionId: SESSION_B }),
      ),
    );
    const targetVisit = useSessionsStore.getState().sessions.get(SESSION_B)?.activationVisitId;
    await store.setActiveSession(SESSION_A);
    expect(invoke).toHaveBeenCalledWith("session.releaseActivationVisit", {
      sessionId: SESSION_B,
      activationVisitId: targetVisit,
    });
    resolveActivation();
    await openTarget;

    expect(useSessionsStore.getState().activeSessionId).toBe(SESSION_A);
    expect(invoke).not.toHaveBeenCalledWith("session.releaseActivationVisit", {
      sessionId: SESSION_A,
      activationVisitId: "visit-a",
    });
    expect(invoke).not.toHaveBeenCalledWith(
      "session.cancelActivationVisitRelease",
      expect.objectContaining({ sessionId: SESSION_A }),
    );
    vi.unstubAllGlobals();
  });

  it("releases a view-only cold-session activation and cancels release on a quick return", async () => {
    let resolveRelease!: (value: { released: boolean }) => void;
    const release = new Promise<{ released: boolean }>((resolve) => {
      resolveRelease = resolve;
    });
    const invoke = vi.fn((channel: string) => {
      if (channel === "session.releaseActivationVisit") return release;
      if (channel === "session.cancelActivationVisitRelease") {
        return Promise.resolve({ cancelled: true });
      }
      return Promise.resolve(undefined);
    });
    vi.stubGlobal("window", { pivis: { invoke } });
    const store = useSessionsStore.getState();
    store.createSession(SESSION_A, WS_A, "/f/a.jsonl", undefined, undefined, "cold");
    store.createSession(SESSION_B, WS_B, "/f/b.jsonl", undefined, undefined, "ready");
    store.setActiveSession(SESSION_A);
    const visitId = useSessionsStore.getState().sessions.get(SESSION_A)?.activationVisitId;
    expect(visitId).toEqual(expect.any(String));
    expect(invoke).toHaveBeenCalledWith("session.activate", {
      sessionId: SESSION_A,
      activationVisitId: visitId,
    });

    store.setActiveSession(SESSION_B);
    expect(invoke).toHaveBeenCalledWith("session.releaseActivationVisit", {
      sessionId: SESSION_A,
      activationVisitId: visitId,
    });
    store.setActiveSession(SESSION_A);
    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("session.cancelActivationVisitRelease", {
        sessionId: SESSION_A,
        activationVisitId: visitId,
      }),
    );
    expect(invoke.mock.calls.filter(([channel]) => channel === "session.activate")).toHaveLength(1);

    resolveRelease({ released: false });
    await vi.waitFor(() =>
      expect(
        useSessionsStore.getState().sessions.get(SESSION_A)?.activationVisitId,
      ).toBeUndefined(),
    );
    vi.unstubAllGlobals();
  });
});

// ── Custom-panel reducer (handlePanelEvent) ────────────────────────────────
// The extension custom() panel state + its bounded replay buffer. None of this
// was covered before; the 512KB trim loop in particular is fiddly.
const PANEL_BUFFER_MAX_BYTES = 512 * 1024;

describe("sessions store - custom panel reducer", () => {
  beforeEach(() => {
    useSessionsStore.setState({
      sessions: new Map(),
      activeSessionId: null,
      workspaces: new Map(),
      activeWorkspacePath: null,
    });
    useSessionsStore.getState().createSession(SESSION_A, WORKSPACE);
  });

  const panel = (id: SessionId = SESSION_A) => useSessionsStore.getState().sessions.get(id)?.panel;

  it("panel_open creates the panel with an empty buffer", () => {
    useSessionsStore.getState().handlePanelEvent(SESSION_A, {
      type: "panel_open",
      panelId: 1,
      overlay: true,
    });
    expect(panel()).toEqual({
      id: 1,
      overlay: true,
      hostInstanceId: "",
      sessionEpoch: 0,
      buffer: [],
    });
  });

  it("panel_data appends to the matching panel's buffer", () => {
    const s = useSessionsStore.getState();
    s.handlePanelEvent(SESSION_A, { type: "panel_open", panelId: 1, overlay: false });
    s.handlePanelEvent(SESSION_A, { type: "panel_data", panelId: 1, data: "a" });
    s.handlePanelEvent(SESSION_A, { type: "panel_data", panelId: 1, data: "b" });
    expect(panel()?.buffer).toEqual(["a", "b"]);
  });

  it("panel_data for a non-matching panelId is ignored", () => {
    const s = useSessionsStore.getState();
    s.handlePanelEvent(SESSION_A, { type: "panel_open", panelId: 1, overlay: false });
    s.handlePanelEvent(SESSION_A, { type: "panel_data", panelId: 99, data: "x" });
    expect(panel()?.buffer).toEqual([]);
  });

  it("panel_data caps the buffer at PANEL_BUFFER_MAX_BYTES, dropping oldest first", () => {
    const s = useSessionsStore.getState();
    s.handlePanelEvent(SESSION_A, { type: "panel_open", panelId: 1, overlay: false });
    const chunk = "x".repeat(100 * 1024); // 100KB each
    // 7 × 100KB = 700KB > 512KB → oldest chunks dropped until under cap.
    for (let i = 0; i < 7; i++) {
      s.handlePanelEvent(SESSION_A, { type: "panel_data", panelId: 1, data: chunk });
    }
    const buf = panel()?.buffer ?? [];
    const total = buf.reduce((n, c) => n + c.length, 0);
    expect(total).toBeLessThanOrEqual(PANEL_BUFFER_MAX_BYTES);
    expect(buf.length).toBeGreaterThan(0); // never trims below one frame
  });

  it("never trims the buffer below a single chunk even if it exceeds the cap", () => {
    const s = useSessionsStore.getState();
    s.handlePanelEvent(SESSION_A, { type: "panel_open", panelId: 1, overlay: false });
    const huge = "y".repeat(PANEL_BUFFER_MAX_BYTES + 10);
    s.handlePanelEvent(SESSION_A, { type: "panel_data", panelId: 1, data: huge });
    // A lone over-cap chunk is retained (the trim loop guards buffer.length > 1).
    expect(panel()?.buffer).toEqual([huge]);
  });

  it("panel_close clears the matching panel", () => {
    const s = useSessionsStore.getState();
    s.handlePanelEvent(SESSION_A, { type: "panel_open", panelId: 1, overlay: false });
    s.handlePanelEvent(SESSION_A, { type: "panel_close", panelId: 1 });
    expect(panel()).toBeUndefined();
  });

  it("panel_close for a non-matching panelId leaves the panel intact", () => {
    const s = useSessionsStore.getState();
    s.handlePanelEvent(SESSION_A, { type: "panel_open", panelId: 1, overlay: false });
    s.handlePanelEvent(SESSION_A, { type: "panel_close", panelId: 2 });
    expect(panel()?.id).toBe(1);
  });

  it("panel_clear_all resets sequence state before a restarted host reuses the id", () => {
    const s = useSessionsStore.getState();
    s.handlePanelEvent(SESSION_A, { type: "panel_open", panelId: 1, overlay: false });
    expect(nextPanelSequence(1)).toBe(1);
    expect(nextPanelSequence(1)).toBe(2);
    s.handlePanelEvent(SESSION_A, { type: "panel_clear_all" });
    s.handlePanelEvent(SESSION_A, { type: "panel_open", panelId: 1, overlay: false });
    expect(nextPanelSequence(1)).toBe(1);
  });

  it("scopes a coalesced same-id replacement input stream to full host identity", () => {
    const s = useSessionsStore.getState();
    s.handlePanelEvent(SESSION_A, {
      type: "panel_open",
      panelId: 1,
      overlay: false,
      hostInstanceId: PANEL_HOST_A,
      sessionEpoch: 0,
    });
    expect(nextPanelSequence(1)).toBe(1);
    expect(nextPanelSequence(1)).toBe(2);

    // Coalesced replacement: no intervening panel_clear_all render. An input
    // from the old passive effect cannot consume the new identity's sequence.
    s.handlePanelEvent(SESSION_A, {
      type: "panel_open",
      panelId: 1,
      overlay: false,
      hostInstanceId: PANEL_HOST_B,
      sessionEpoch: 0,
    });
    expect(nextPanelSequence(1, PANEL_HOST_A)).toBe(1);

    expect(panel()).toMatchObject({
      id: 1,
      hostInstanceId: PANEL_HOST_B,
      sessionEpoch: 0,
    });
    expect(nextPanelSequence(1, PANEL_HOST_B)).toBe(1);
  });

  it("panel_clear_all clears the panel unconditionally", () => {
    const s = useSessionsStore.getState();
    s.handlePanelEvent(SESSION_A, { type: "panel_open", panelId: 1, overlay: false });
    s.handlePanelEvent(SESSION_A, { type: "panel_clear_all" });
    expect(panel()).toBeUndefined();
  });

  const unifiedPanel = (id: SessionId = SESSION_A) =>
    useSessionsStore.getState().sessions.get(id)?.unifiedPanel;

  it("panel_mode sets the unified panel's sizing mode (viewport ↔ content)", () => {
    const s = useSessionsStore.getState();
    s.handlePanelEvent(SESSION_A, {
      type: "panel_open",
      panelId: 1,
      overlay: false,
      unified: true,
    });
    // Default (no panel_mode yet) leaves mode unset → renderer treats as content.
    expect(unifiedPanel()?.mode).toBeUndefined();

    s.handlePanelEvent(SESSION_A, { type: "panel_mode", panelId: 1, mode: "viewport" });
    expect(unifiedPanel()?.mode).toBe("viewport");

    s.handlePanelEvent(SESSION_A, { type: "panel_mode", panelId: 1, mode: "content" });
    expect(unifiedPanel()?.mode).toBe("content");
  });

  it("panel_mode for a non-matching panelId is ignored", () => {
    const s = useSessionsStore.getState();
    s.handlePanelEvent(SESSION_A, {
      type: "panel_open",
      panelId: 1,
      overlay: false,
      unified: true,
    });
    s.handlePanelEvent(SESSION_A, { type: "panel_mode", panelId: 99, mode: "viewport" });
    expect(unifiedPanel()?.mode).toBeUndefined();
  });

  it("session_warning surfaces a warning toast", () => {
    useSessionsStore.getState().handlePanelEvent(SESSION_A, {
      type: "session_warning",
      message: "Session file is open in another pi instance. Changes may conflict.",
    });
    const toasts = useSessionsStore.getState().sessions.get(SESSION_A)?.toasts ?? [];
    expect(toasts.at(-1)).toMatchObject({ type: "warning" });
  });

  it("is a no-op for an unknown session", () => {
    useSessionsStore.getState().handlePanelEvent("nope" as SessionId, {
      type: "panel_open",
      panelId: 1,
      overlay: false,
    });
    expect(useSessionsStore.getState().sessions.has("nope" as SessionId)).toBe(false);
  });
});

// ── Working-indicator gating (shouldShowWorkingIndicator) ──────────────────
// Extension UI that is merely waiting for user input should not look like
// model/tool work, but a real active transcript stream must stay visible even
// if an extension UI surface is also open.
describe("sessions store - shouldShowWorkingIndicator", () => {
  beforeEach(() => {
    useSessionsStore.setState({
      sessions: new Map(),
      activeSessionId: null,
      workspaces: new Map(),
      activeWorkspacePath: null,
    });
    useSessionsStore.getState().createSession(SESSION_A, WORKSPACE);
  });
  const session = () => useSessionsStore.getState().sessions.get(SESSION_A);

  it("does not use direct runtime availability", () => {
    useSessionsStore.getState().applyRuntimeState(SESSION_A, runtimeState(true));
    expect(shouldShowWorkingIndicator(session())).toBe(false);
  });
});

/**
 * These tests pin the two model/thinking-level invariants:
 *
 *   1. The dropdown reflects the session's current (or just-requested) model /
 *      thinking level — i.e. `state.sessions.get(id).currentModel` /
 *      `.thinkingLevel`, which only the bootstrap, pi events, and the user's
 *      own actions in THAT session ever write.
 *   2. A session's model / level NEVER changes unless the user changes it in
 *      that same session. In particular, switching to another session, picking
 *      a model there (which updates the GLOBAL last-used preference), and
 *      switching back must not re-apply that preference to the first session.
 *
 * `bootstrapModelState` is the single place the global preference is applied,
 * guarded by `modelInitialized` so it runs at most once per session no matter
 * how many times the SessionHeader remounts (every tab switch remounts it).
 */
describe("sessions store - authority model and thinking intents", () => {
  const MODEL_X = { id: "openrouter/model-x", provider: "openrouter" } as ModelInfo;
  const MODEL_Y = { id: "openrouter/model-y", provider: "openrouter" } as ModelInfo;

  beforeEach(() => {
    useSessionsStore.setState({
      sessions: new Map(),
      activeSessionId: null,
      workspaces: new Map(),
      activeWorkspacePath: null,
    });
    useSessionsStore.getState().createSession(SESSION_A, WORKSPACE);
    installAuthority();
    useSettingsStore.setState({
      settings: {
        ...useSettingsStore.getState().settings,
        lastUsedModel: null,
        lastUsedThinkingLevel: null,
      },
      update: vi.fn(async () => {}) as never,
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("applies a new-session model preference once, but only the confirming frame selects it", async () => {
    useSettingsStore.setState({
      settings: {
        ...useSettingsStore.getState().settings,
        lastUsedModel: { provider: MODEL_Y.provider!, modelId: MODEL_Y.id },
      },
    });
    const invoke = vi.fn(
      async (channel: string, payload: { queryId?: string; query?: { type: string } }) => {
        if (channel === "session.query")
          return {
            queryId: payload.queryId,
            owner: { hostInstanceId: "host-1", sessionEpoch: 1 },
            queryType: payload.query!.type,
            response: { success: true, data: { models: [MODEL_X, MODEL_Y] } },
          };
        return {
          status: "admitted",
          intentId: "model-pref",
          owner: { hostInstanceId: "host-1", sessionEpoch: 1 },
        };
      },
    );
    vi.stubGlobal("window", { pivis: { invoke } });
    await useSessionsStore.getState().bootstrapModelState(SESSION_A);
    expect(invoke).toHaveBeenCalledWith(
      "session.dispatchIntent",
      expect.objectContaining({
        intent: { kind: "setModel", provider: "openrouter", modelId: "openrouter/model-y" },
      }),
    );
    expect(useSessionsStore.getState().sessions.get(SESSION_A)?.currentModel).toBe("model-old");
    publishSemantic(SESSION_A, 2, semanticSnapshot(2, { model: MODEL_Y }));
    expect(useSessionsStore.getState().sessions.get(SESSION_A)?.currentModel).toBe(MODEL_Y.id);
    await useSessionsStore.getState().bootstrapModelState(SESSION_A);
    expect(
      invoke.mock.calls.filter(([channel]) => channel === "session.dispatchIntent"),
    ).toHaveLength(1);
  });

  it("does not guess between duplicate provider model ids", async () => {
    useSettingsStore.setState({
      settings: {
        ...useSettingsStore.getState().settings,
        lastUsedModel: { provider: "groq", modelId: "llama-4" },
      },
    });
    const invoke = vi.fn(
      async (channel: string, payload: { queryId?: string; query?: { type: string } }) =>
        channel === "session.query"
          ? {
              queryId: payload.queryId,
              owner: { hostInstanceId: "host-1", sessionEpoch: 1 },
              queryType: payload.query!.type,
              response: {
                success: true,
                data: {
                  models: [
                    { id: "llama-4", provider: "together" },
                    { id: "llama-4", provider: "openrouter" },
                  ],
                },
              },
            }
          : {
              status: "admitted",
              intentId: "unexpected",
              owner: { hostInstanceId: "host-1", sessionEpoch: 1 },
            },
    );
    vi.stubGlobal("window", { pivis: { invoke } });
    await useSessionsStore.getState().bootstrapModelState(SESSION_A);
    expect(invoke.mock.calls.some(([channel]) => channel === "session.dispatchIntent")).toBe(false);
  });

  it("keeps model and thinking canonical values unchanged for rejected or unknown receipts", async () => {
    vi.stubGlobal("window", {
      pivis: {
        invoke: vi.fn(async () => ({
          status: "not_admitted",
          reason: "rejected",
          intentId: "no",
          owner: { hostInstanceId: "host-1", sessionEpoch: 1 },
        })),
      },
    });
    await expect(
      useSessionsStore.getState().applyModelChange(SESSION_A, MODEL_Y),
    ).resolves.toMatchObject({ ok: false });
    await expect(
      useSessionsStore.getState().applyThinkingLevel(SESSION_A, "high"),
    ).resolves.toMatchObject({ ok: false });
    expect(useSessionsStore.getState().sessions.get(SESSION_A)).toMatchObject({
      currentModel: "model-old",
      thinkingLevel: "low",
    });
  });

  it("keeps admitted intent receipts non-optimistic and projects Pi's clamped terminal values", async () => {
    vi.stubGlobal("window", {
      pivis: {
        invoke: vi.fn(async () => ({
          status: "admitted",
          intentId: "yes",
          owner: { hostInstanceId: "host-1", sessionEpoch: 1 },
        })),
      },
    });
    await expect(useSessionsStore.getState().applyModelChange(SESSION_A, MODEL_Y)).resolves.toEqual(
      { ok: true },
    );
    await expect(
      useSessionsStore.getState().applyThinkingLevel(SESSION_A, "xhigh"),
    ).resolves.toEqual({ ok: true });
    expect(useSessionsStore.getState().sessions.get(SESSION_A)).toMatchObject({
      currentModel: "model-old",
      thinkingLevel: "low",
    });
    publishSemantic(SESSION_A, 2, semanticSnapshot(2, { model: MODEL_Y, thinkingLevel: "high" }));
    expect(useSessionsStore.getState().sessions.get(SESSION_A)).toMatchObject({
      currentModel: MODEL_Y.id,
      currentProvider: MODEL_Y.provider,
      thinkingLevel: "high",
    });
  });
});

describe("sessions store - worktree mode / attach path", () => {
  beforeEach(() => {
    useSessionsStore.setState({
      sessions: new Map(),
      activeSessionId: null,
      workspaces: new Map(),
      activeWorkspacePath: null,
    });
    useSessionsStore.getState().createSession(SESSION_A, WORKSPACE);
  });

  it("createSession resets the worktree fields to undefined", () => {
    const session = useSessionsStore.getState().sessions.get(SESSION_A);
    expect(session?.worktreeMode).toBeUndefined();
    expect(session?.worktreeAttachPath).toBeUndefined();
    expect(session?.worktreeBase).toBeUndefined();
    expect(session?.worktreeCreating).toBeUndefined();
    expect(session?.worktreeError).toBeUndefined();
  });

  it("setWorktreeMode updates the mode and clears any prior error", () => {
    // Seed a stale error (e.g. from a previous failed attach) so we can
    // assert it gets cleared on mode change.
    useSessionsStore.getState().setWorktreeError(SESSION_A, "stale failure");
    expect(useSessionsStore.getState().sessions.get(SESSION_A)?.worktreeError).toBe(
      "stale failure",
    );

    useSessionsStore.getState().setWorktreeMode(SESSION_A, "attach");
    const session = useSessionsStore.getState().sessions.get(SESSION_A);
    expect(session?.worktreeMode).toBe("attach");
    expect(session?.worktreeError).toBeUndefined();
  });

  it("setWorktreeAttachPath updates the path and clears any prior error", () => {
    useSessionsStore.getState().setWorktreeMode(SESSION_A, "attach");
    useSessionsStore.getState().setWorktreeError(SESSION_A, "stale failure");

    useSessionsStore.getState().setWorktreeAttachPath(SESSION_A, "/path/to/wt");
    const session = useSessionsStore.getState().sessions.get(SESSION_A);
    expect(session?.worktreeAttachPath).toBe("/path/to/wt");
    expect(session?.worktreeError).toBeUndefined();
  });

  it("setWorktreeMode drops worktreeAttachPath when switching away from attach", () => {
    // Set up an attach path so the next assertion has something to drop.
    useSessionsStore.getState().setWorktreeMode(SESSION_A, "attach");
    useSessionsStore.getState().setWorktreeAttachPath(SESSION_A, "/path/to/wt");
    expect(useSessionsStore.getState().sessions.get(SESSION_A)?.worktreeAttachPath).toBe(
      "/path/to/wt",
    );

    // Switching to "create" must drop the attach path so it can't leak
    // into a future attempt where the user picked a different path.
    useSessionsStore.getState().setWorktreeMode(SESSION_A, "create");
    expect(useSessionsStore.getState().sessions.get(SESSION_A)?.worktreeMode).toBe("create");
    expect(useSessionsStore.getState().sessions.get(SESSION_A)?.worktreeAttachPath).toBeUndefined();
  });

  it("setWorktreeAttachPath is a no-op for unknown sessions", () => {
    useSessionsStore.getState().setWorktreeAttachPath("unknown" as SessionId, "/path");
    expect(useSessionsStore.getState().sessions.has("unknown" as SessionId)).toBe(false);
  });

  it("clearWorktreeIntent resets worktreeMode + worktreeAttachPath (and the other worktree fields)", () => {
    // Set every worktree field so we can confirm the clear is exhaustive.
    useSessionsStore.getState().setWorktreeMode(SESSION_A, "attach");
    useSessionsStore.getState().setWorktreeAttachPath(SESSION_A, "/path/to/wt");
    useSessionsStore.getState().setWorktreeBase(SESSION_A, "main");
    useSessionsStore.getState().setWorktreeCreating(SESSION_A, true);
    useSessionsStore.getState().setWorktreeError(SESSION_A, "stale");

    useSessionsStore.getState().clearWorktreeIntent(SESSION_A);
    const session = useSessionsStore.getState().sessions.get(SESSION_A);
    expect(session?.worktreeMode).toBeUndefined();
    expect(session?.worktreeAttachPath).toBeUndefined();
    expect(session?.worktreeBase).toBeUndefined();
    expect(session?.worktreeCreating).toBeUndefined();
    expect(session?.worktreeError).toBeUndefined();
  });
});

describe("sessions store - pending new session + per-workspace drafts", () => {
  beforeEach(() => {
    useSessionsStore.setState({
      sessions: new Map(),
      activeSessionId: null,
      workspaces: new Map(),
      activeWorkspacePath: null,
      newSessionDrafts: new Map(),
      newSessionSetupDrafts: new Map(),
      sessionDrafts: new Map(),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("createSession marks a fileless session pending and a resumed one not", () => {
    const store = useSessionsStore.getState();
    store.createSession(SESSION_A, WORKSPACE); // no file → brand new
    store.createSession(SESSION_B, WORKSPACE, "/f/b.jsonl"); // resumed
    const a = useSessionsStore.getState().sessions.get(SESSION_A);
    const b = useSessionsStore.getState().sessions.get(SESSION_B);
    expect(a?.isNewPending).toBe(true);
    expect(isNewSessionPending(a)).toBe(true);
    expect(b?.isNewPending).toBe(false);
    expect(isNewSessionPending(b)).toBe(false);
  });

  it("addUserMessage clears isNewPending and the workspace draft", () => {
    const store = useSessionsStore.getState();
    store.createSession(SESSION_A, WORKSPACE);
    store.setNewSessionDraft(WORKSPACE, "half-typed");
    expect(useSessionsStore.getState().newSessionDrafts.get(WORKSPACE)).toBe("half-typed");
    store.addUserMessage(SESSION_A, "hello");
    expect(useSessionsStore.getState().sessions.get(SESSION_A)?.isNewPending).toBe(false);
    expect(useSessionsStore.getState().newSessionDrafts.has(WORKSPACE)).toBe(false);
  });

  it("renders attachment metadata from an authoritative user echo", () => {
    const store = useSessionsStore.getState();
    store.createSession(SESSION_A, WORKSPACE);

    store.applyEvent(SESSION_A, {
      type: "message_start",
      message: {
        role: "user",
        content: [
          { type: "text", text: "describe this" },
          { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
        ],
      },
      queueIntentId: "intent-image",
    });
    // A queued=true custody response may cross IPC after this echo. Its
    // post-ack reconciliation must preserve the authoritative block rather
    // than append an optimistic duplicate.
    store.addUserMessage(SESSION_A, "describe this", ["data:image/png;base64,aW1hZ2U="], {
      registerEcho: true,
      afterUserMessageSequence: 0,
      intentId: "intent-image",
    });

    const blocks = useSessionsStore.getState().sessions.get(SESSION_A)?.transcript.blocks;
    expect(blocks).toHaveLength(1);
    expect(blocks?.[0]).toMatchObject({
      type: "user",
      data: {
        content: "describe this",
        images: ["data:image/png;base64,aW1hZ2U="],
      },
    });
  });

  it("preserves the count of concurrent identical queued prompts across crossed acknowledgements", () => {
    const store = useSessionsStore.getState();
    store.createSession(SESSION_A, WORKSPACE);

    store.applyEvent(SESSION_A, {
      type: "message_start",
      message: { role: "user", content: "transformed first" },
      queueIntentId: "intent-repeat-a",
    });
    store.addUserMessage(SESSION_A, "repeat", undefined, {
      registerEcho: true,
      afterUserMessageSequence: 0,
      intentId: "intent-repeat-a",
    });
    store.addUserMessage(SESSION_A, "repeat", undefined, {
      registerEcho: true,
      afterUserMessageSequence: 0,
      intentId: "intent-repeat-b",
    });
    store.applyEvent(SESSION_A, {
      type: "message_start",
      message: { role: "user", content: "transformed second" },
      queueIntentId: "intent-repeat-b",
    });

    const blocks = useSessionsStore.getState().sessions.get(SESSION_A)?.transcript.blocks;
    expect(blocks?.filter((block) => block.type === "user")).toHaveLength(2);
  });

  it("clearPendingUserEcho removes a failed optimistic first prompt and restores the workspace draft", () => {
    const store = useSessionsStore.getState();
    store.createSession(SESSION_A, WORKSPACE);
    store.addUserMessage(SESSION_A, "retry me");

    store.clearPendingUserEcho(SESSION_A, "retry me");

    const session = useSessionsStore.getState().sessions.get(SESSION_A);
    expect(session?.isNewPending).toBe(true);
    expect(session?.transcript.blocks).toHaveLength(0);
    expect(useSessionsStore.getState().newSessionDrafts.get(WORKSPACE)).toBe("retry me");
  });

  it("clearPendingUserEcho removes a failed optimistic prompt in existing sessions and restores its draft", () => {
    const store = useSessionsStore.getState();
    store.createSession(SESSION_A, WORKSPACE, "/f/a.jsonl");
    store.addUserMessage(SESSION_A, "retry me");

    store.clearPendingUserEcho(SESSION_A, "retry me");

    const session = useSessionsStore.getState().sessions.get(SESSION_A);
    expect(session?.isNewPending).toBe(false);
    expect(session?.transcript.blocks).toHaveLength(0);
    expect(useSessionsStore.getState().sessionDrafts.get(SESSION_A)).toBe("retry me");
  });

  it("addBashCommand clears isNewPending and the workspace draft", () => {
    const store = useSessionsStore.getState();
    store.createSession(SESSION_A, WORKSPACE);
    store.setNewSessionDraft(WORKSPACE, "!ls");
    store.addBashCommand(SESSION_A, "ls");
    expect(useSessionsStore.getState().sessions.get(SESSION_A)?.isNewPending).toBe(false);
    expect(useSessionsStore.getState().newSessionDrafts.has(WORKSPACE)).toBe(false);
  });

  it("addCustomMessage clears isNewPending and the workspace draft", () => {
    const store = useSessionsStore.getState();
    store.createSession(SESSION_A, WORKSPACE);
    store.setNewSessionDraft(WORKSPACE, "/skill");
    store.addCustomMessage(SESSION_A, "custom content");
    expect(useSessionsStore.getState().sessions.get(SESSION_A)?.isNewPending).toBe(false);
    expect(useSessionsStore.getState().newSessionDrafts.has(WORKSPACE)).toBe(false);
  });

  it("applyEvent promotes a pending session without losing a newer skill/template draft", () => {
    const store = useSessionsStore.getState();
    store.createSession(SESSION_A, WORKSPACE);
    store.setNewSessionDraft(WORKSPACE, "new text typed after /some-skill");
    // Skill/template sends bypass the optimistic addUserMessage — pi echoes the
    // user message directly. With no pending echo this adds a user block, which
    // is the authoritative "first message landed" signal.
    store.applyEvent(SESSION_A, {
      type: "message_start",
      message: { role: "user", content: "expanded skill prompt" },
    });
    const a = useSessionsStore.getState().sessions.get(SESSION_A);
    expect(a?.isNewPending).toBe(false);
    expect(a?.transcript.blocks.length).toBeGreaterThan(0);
    expect(useSessionsStore.getState().newSessionDrafts.has(WORKSPACE)).toBe(false);
    expect(useSessionsStore.getState().sessionDrafts.get(SESSION_A)).toBe(
      "new text typed after /some-skill",
    );
  });

  it("applyEvent does NOT promote (or drop the draft) on a spontaneous custom message", () => {
    const store = useSessionsStore.getState();
    store.createSession(SESSION_A, WORKSPACE);
    store.setNewSessionDraft(WORKSPACE, "draft in progress");
    // An extension emits a custom banner before the user sends anything. It
    // renders a transcript block but is NOT a user echo — the session must stay
    // pending and keep its draft (otherwise the in-progress composer text would
    // be wiped on the premature pending→real transition).
    store.applyEvent(SESSION_A, {
      type: "message_start",
      message: { role: "custom", customType: "banner", content: "Welcome", display: true },
    });
    const a = useSessionsStore.getState().sessions.get(SESSION_A);
    expect(a?.transcript.blocks.length).toBeGreaterThan(0); // the banner rendered
    expect(a?.isNewPending).toBe(true); // but the session is still pending
    expect(useSessionsStore.getState().newSessionDrafts.get(WORKSPACE)).toBe("draft in progress");
  });

  it("removeSession clears the draft and setup of a still-pending session", () => {
    const store = useSessionsStore.getState();
    store.createSession(SESSION_A, WORKSPACE);
    store.setNewSessionDraft(WORKSPACE, "lost on close");
    store.setWorktreeMode(SESSION_A, "create");
    store.removeSession(SESSION_A);
    expect(useSessionsStore.getState().newSessionDrafts.has(WORKSPACE)).toBe(false);
    expect(useSessionsStore.getState().newSessionSetupDrafts.has(WORKSPACE)).toBe(false);
  });

  it("removeWorkspace clears its draft and setup", () => {
    const store = useSessionsStore.getState();
    store.addWorkspace(WORKSPACE);
    store.setNewSessionDraft(WORKSPACE, "gone with the workspace");
    useSessionsStore.setState({
      newSessionSetupDrafts: new Map([[WORKSPACE, { worktreeMode: "create" }]]),
    });
    store.removeWorkspace(WORKSPACE);
    expect(useSessionsStore.getState().newSessionDrafts.has(WORKSPACE)).toBe(false);
    expect(useSessionsStore.getState().newSessionSetupDrafts.has(WORKSPACE)).toBe(false);
  });

  it("setNewSessionDraft / clearNewSessionDraft round-trip", () => {
    const store = useSessionsStore.getState();
    store.setNewSessionDraft(WORKSPACE, "typed");
    expect(useSessionsStore.getState().newSessionDrafts.get(WORKSPACE)).toBe("typed");
    store.clearNewSessionDraft(WORKSPACE);
    expect(useSessionsStore.getState().newSessionDrafts.has(WORKSPACE)).toBe(false);
  });

  it("isPendingNewSessionActiveFor tracks the active pending session per workspace", () => {
    const store = useSessionsStore.getState();
    store.createSession(SESSION_A, WORKSPACE); // pending
    store.createSession(SESSION_B, "/other-ws"); // pending, different ws
    // No active session yet.
    expect(isPendingNewSessionActiveFor(useSessionsStore.getState(), WORKSPACE)).toBe(false);
    // Activate A.
    useSessionsStore.setState({ activeSessionId: SESSION_A });
    expect(isPendingNewSessionActiveFor(useSessionsStore.getState(), WORKSPACE)).toBe(true);
    // Right session, wrong workspace.
    expect(isPendingNewSessionActiveFor(useSessionsStore.getState(), "/other-ws")).toBe(false);
    // Once A has content it is no longer a pending new session.
    store.addUserMessage(SESSION_A, "hi");
    expect(isPendingNewSessionActiveFor(useSessionsStore.getState(), WORKSPACE)).toBe(false);
  });

  it("reaps an idle pending new session when switching away but preserves draft and setup", async () => {
    const invoke = vi.fn(async () => ({ success: true }));
    vi.stubGlobal("window", { pivis: { invoke } });
    const store = useSessionsStore.getState();
    store.addWorkspace(WORKSPACE);
    store.createSession(SESSION_A, WORKSPACE);
    store.createSession(SESSION_B, WORKSPACE, "/f/b.jsonl", undefined, undefined, "ready");
    store.setNewSessionDraft(WORKSPACE, "discard me");
    store.setWorktreeMode(SESSION_A, "attach");
    store.setWorktreeAttachPath(SESSION_A, "/tmp/worktree-a");
    store.setWorktreeBase(SESSION_A, "main");
    useSessionsStore.setState({ activeSessionId: SESSION_A, activeWorkspacePath: WORKSPACE });

    store.setActiveSession(SESSION_B);
    await vi.waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("session.prepareClose", { sessionId: SESSION_A });
      expect(useSessionsStore.getState().sessions.has(SESSION_A)).toBe(false);
    });
    expect(useSessionsStore.getState().newSessionDrafts.get(WORKSPACE)).toBe("discard me");
    expect(useSessionsStore.getState().activeSessionId).toBe(SESSION_B);

    store.createSession(SESSION_C, WORKSPACE);
    const nextPending = useSessionsStore.getState().sessions.get(SESSION_C);
    expect(nextPending?.worktreeMode).toBe("attach");
    expect(nextPending?.worktreeAttachPath).toBe("/tmp/worktree-a");
    expect(nextPending?.worktreeBase).toBe("main");
  });

  it("does not reap a pending session once a send is in flight", async () => {
    const invoke = vi.fn(async () => ({ success: true }));
    vi.stubGlobal("window", { pivis: { invoke } });
    const store = useSessionsStore.getState();
    store.createSession(SESSION_A, WORKSPACE);
    store.createSession(SESSION_B, WORKSPACE, "/f/b.jsonl", undefined, undefined, "ready");
    store.applyAuthorityAttach(
      SESSION_A,
      authorityAttach(
        semanticSnapshot(1, {
          sdk: {
            isStreaming: true,
            isIdle: false,
            isCompacting: false,
            isRetrying: false,
            retryAttempt: 0,
            isBashRunning: false,
          },
        }),
      ),
    );
    useSessionsStore.setState({ activeSessionId: SESSION_A, activeWorkspacePath: WORKSPACE });

    store.setActiveSession(SESSION_B);
    await Promise.resolve();

    expect(invoke).not.toHaveBeenCalledWith("session.prepareClose", { sessionId: SESSION_A });
    expect(useSessionsStore.getState().sessions.has(SESSION_A)).toBe(true);
  });

  it("openSessionTab no-ops for a repeated + New session click in the active workspace", async () => {
    const invoke = vi.fn(async () => ({ outcome: "opened", sessionId: SESSION_B }));
    vi.stubGlobal("window", { pivis: { invoke } });
    const store = useSessionsStore.getState();
    store.createSession(SESSION_A, WORKSPACE);
    useSessionsStore.setState({ activeSessionId: SESSION_A, activeWorkspacePath: WORKSPACE });

    await expect(store.openSessionTab(WORKSPACE)).resolves.toBe(SESSION_A);
    expect(invoke).not.toHaveBeenCalledWith("session.open", expect.anything());
    expect(useSessionsStore.getState().sessions.has(SESSION_A)).toBe(true);
  });

  it("openSessionTab seeds the complete loadHistory response", async () => {
    const invoke = vi.fn(async (channel: string, payload?: unknown) => {
      if (channel === "session.open") {
        return {
          outcome: "opened",
          sessionId: SESSION_A,
          name: null,
          preview: null,
          sessionStatus: "ready",
        };
      }
      if (channel === "session.loadHistory") {
        return loadedHistory(payload, [
          { id: "h1", type: "user", data: { content: "first" } },
          { id: "h2", type: "user", data: { content: "resumed" } },
        ]);
      }
      return [];
    });
    vi.stubGlobal("window", { pivis: { invoke } });

    await expect(useSessionsStore.getState().openSessionTab(WORKSPACE, "/f/a.jsonl")).resolves.toBe(
      SESSION_A,
    );

    const session = useSessionsStore.getState().sessions.get(SESSION_A);
    expect(session ? allTranscriptBlocks(session.transcript).map((b) => b.id) : undefined).toEqual([
      "h1",
      "h2",
    ]);
  });

  it("restores authoritative worktree-operation custody when reopening after renderer reload", async () => {
    const invoke = vi.fn(async (channel: string, payload?: unknown) => {
      if (channel === "session.open") {
        return {
          outcome: "existing",
          sessionId: SESSION_A,
          name: null,
          preview: null,
          sessionStatus: "ready",
          worktreeOperationInProgress: true,
          worktreeIdentityRevision: 4,
        };
      }
      if (channel === "session.worktreeOperationStatus") return true;
      if (channel === "session.worktreeSnapshot") return { revision: 4 };
      if (channel === "session.loadHistory") {
        return loadedHistory(payload, []);
      }
      throw new Error(`unexpected channel ${channel}`);
    });
    vi.stubGlobal("window", { pivis: { invoke } });

    await useSessionsStore.getState().openSessionTab(WORKSPACE, "/f/a.jsonl");

    expect(useSessionsStore.getState().sessions.get(SESSION_A)?.worktreeCreating).toBe(true);
    expect(invoke).toHaveBeenCalledWith("session.worktreeOperationStatus", {
      sessionId: SESSION_A,
    });
  });

  it("uses a post-reconstruction identity snapshot and ignores stale identity revisions", async () => {
    const invoke = vi.fn(async (channel: string, payload?: unknown) => {
      if (channel === "session.open") {
        return {
          outcome: "existing",
          sessionId: SESSION_A,
          name: null,
          preview: null,
          sessionStatus: "ready",
          worktreeOperationInProgress: false,
          worktreeIdentityRevision: 1,
          worktree: {
            path: "/stale-worktree",
            branch: "stale",
            name: "stale",
            base: "main",
          },
        };
      }
      if (channel === "session.worktreeSnapshot") return { revision: 2 };
      if (channel === "session.loadHistory") {
        return loadedHistory(payload, []);
      }
      throw new Error(`unexpected channel ${channel}`);
    });
    vi.stubGlobal("window", { pivis: { invoke } });

    await useSessionsStore.getState().openSessionTab(WORKSPACE, "/f/a.jsonl");
    expect(useSessionsStore.getState().sessions.get(SESSION_A)).toMatchObject({
      worktreePath: undefined,
      worktreeIdentityRevision: 2,
    });

    useSessionsStore
      .getState()
      .applyWorktree(
        SESSION_A,
        { worktreePath: "/late-stale", branch: "stale", name: "stale", base: "main" },
        1,
      );
    expect(useSessionsStore.getState().sessions.get(SESSION_A)?.worktreePath).toBeUndefined();
  });

  it("rereads open-session history when a transcript event arrives during hydration", async () => {
    const historyRequests: Array<{
      payload: unknown;
      resolve: (history: ReturnType<typeof loadedHistory>) => void;
    }> = [];
    const invoke = vi.fn((channel: string, payload?: unknown) => {
      if (channel === "session.open") {
        return Promise.resolve({
          outcome: "opened",
          sessionId: SESSION_A,
          name: null,
          preview: null,
          sessionStatus: "cold",
        });
      }
      if (channel === "session.loadHistory") {
        return new Promise((resolve) => historyRequests.push({ payload, resolve }));
      }
      return Promise.resolve([]);
    });
    vi.stubGlobal("window", { pivis: { invoke } });

    const pending = useSessionsStore.getState().openSessionTab(WORKSPACE, "/f/a.jsonl");
    await vi.waitFor(() => expect(historyRequests).toHaveLength(1));
    useSessionsStore.getState().applyEvent(SESSION_A, {
      type: "message_start",
      message: { role: "user", content: "racing event" },
    });
    historyRequests[0]!.resolve(
      loadedHistory(historyRequests[0]!.payload, [
        { id: "old-history", type: "user", data: { content: "before race" } },
      ]),
    );

    await vi.waitFor(() => expect(historyRequests).toHaveLength(2));
    historyRequests[1]!.resolve(
      loadedHistory(historyRequests[1]!.payload, [
        { id: "persisted-race", type: "user", data: { content: "racing event" } },
      ]),
    );
    await expect(pending).resolves.toBe(SESSION_A);

    const session = useSessionsStore.getState().sessions.get(SESSION_A);
    expect(session ? allTranscriptBlocks(session.transcript).map((block) => block.id) : []).toEqual(
      ["persisted-race"],
    );
  });

  it("adoptSessionFile clears previously hydrated history", async () => {
    const store = useSessionsStore.getState();
    store.createSession(SESSION_A, WORKSPACE, "/f/a.jsonl");
    store.seedHistory(SESSION_A, [{ id: "history", type: "user", data: { content: "history" } }]);

    await store.adoptSessionFile(SESSION_A, undefined);

    const session = useSessionsStore.getState().sessions.get(SESSION_A);
    expect(session ? allTranscriptBlocks(session.transcript) : undefined).toEqual([]);
  });

  it("tree history makes an empty visible branch count as real session history", () => {
    const store = useSessionsStore.getState();
    store.createSession(SESSION_A, WORKSPACE, "/f/a.jsonl");
    let session = useSessionsStore.getState().sessions.get(SESSION_A);
    expect(session?.transcript.blocks).toEqual([]);
    expect(sessionHasHistory(session)).toBe(false);

    store.setTreeHistoryPresent(SESSION_A, true);
    session = useSessionsStore.getState().sessions.get(SESSION_A);
    expect(sessionHasHistory(session)).toBe(true);
    expect(isNewSessionPending(session)).toBe(false);
  });

  it("tree bootstrap entries do not promote a truly blank fileless pending session", () => {
    const store = useSessionsStore.getState();
    store.createSession(SESSION_A, WORKSPACE);
    store.setTreeHistoryPresent(SESSION_A, true);

    const session = useSessionsStore.getState().sessions.get(SESSION_A);
    expect(session?.hasTreeHistory).toBe(false);
    expect(isNewSessionPending(session)).toBe(true);
  });
});

describe("sessions store - per-session drafts (non-pending)", () => {
  beforeEach(() => {
    useSessionsStore.setState({
      sessions: new Map(),
      activeSessionId: null,
      workspaces: new Map(),
      activeWorkspacePath: null,
      newSessionDrafts: new Map(),
      sessionDrafts: new Map(),
    });
  });

  it("setSessionDraft stores and clears per-session draft text", () => {
    const store = useSessionsStore.getState();
    store.setSessionDraft(SESSION_A, "half-typed");
    expect(useSessionsStore.getState().sessionDrafts.get(SESSION_A)).toBe("half-typed");
    // Empty text deletes the entry (no lingering empty values).
    store.setSessionDraft(SESSION_A, "");
    expect(useSessionsStore.getState().sessionDrafts.has(SESSION_A)).toBe(false);
    // Clearing a non-existent entry is a no-op (same ref).
    const before = useSessionsStore.getState().sessionDrafts;
    store.setSessionDraft(SESSION_B, "");
    expect(useSessionsStore.getState().sessionDrafts).toBe(before);
  });

  it("drafts are isolated per session", () => {
    const store = useSessionsStore.getState();
    store.setSessionDraft(SESSION_A, "text in A");
    store.setSessionDraft(SESSION_B, "text in B");
    expect(useSessionsStore.getState().sessionDrafts.get(SESSION_A)).toBe("text in A");
    expect(useSessionsStore.getState().sessionDrafts.get(SESSION_B)).toBe("text in B");
  });

  it("addUserMessage clears the per-session draft once the message lands", () => {
    const store = useSessionsStore.getState();
    // A resumed (non-pending) session with an in-progress draft.
    store.createSession(SESSION_A, WORKSPACE, "/f/a.jsonl");
    store.setSessionDraft(SESSION_A, "unsent follow-up");
    store.addUserMessage(SESSION_A, "sent message");
    expect(useSessionsStore.getState().sessionDrafts.has(SESSION_A)).toBe(false);
  });

  it("addBashCommand clears the per-session draft", () => {
    const store = useSessionsStore.getState();
    store.createSession(SESSION_A, WORKSPACE, "/f/a.jsonl");
    store.setSessionDraft(SESSION_A, "!ls");
    store.addBashCommand(SESSION_A, "ls");
    expect(useSessionsStore.getState().sessionDrafts.has(SESSION_A)).toBe(false);
  });

  it("addCustomMessage clears the per-session draft", () => {
    const store = useSessionsStore.getState();
    store.createSession(SESSION_A, WORKSPACE, "/f/a.jsonl");
    store.setSessionDraft(SESSION_A, "/skill");
    store.addCustomMessage(SESSION_A, "custom content");
    expect(useSessionsStore.getState().sessionDrafts.has(SESSION_A)).toBe(false);
  });

  it("removeSession clears that session's draft (no leak to other sessions)", () => {
    const store = useSessionsStore.getState();
    store.createSession(SESSION_A, WORKSPACE, "/f/a.jsonl");
    store.createSession(SESSION_B, WORKSPACE, "/f/b.jsonl");
    store.setSessionDraft(SESSION_A, "A's draft");
    store.setSessionDraft(SESSION_B, "B's draft");
    store.removeSession(SESSION_A);
    expect(useSessionsStore.getState().sessionDrafts.has(SESSION_A)).toBe(false);
    expect(useSessionsStore.getState().sessionDrafts.get(SESSION_B)).toBe("B's draft");
  });
});

describe("sessions store - editorInjection lifecycle", () => {
  beforeEach(() => {
    useSessionsStore.setState({
      sessions: new Map(),
      activeSessionId: null,
      workspaces: new Map(),
      activeWorkspacePath: null,
      newSessionDrafts: new Map(),
      sessionDrafts: new Map(),
    });
  });

  it("injectEditorText sets and clearEditorInjection clears", () => {
    const store = useSessionsStore.getState();
    store.createSession(SESSION_A, WORKSPACE, "/f/a.jsonl");
    store.injectEditorText(SESSION_A, "injected");
    expect(useSessionsStore.getState().sessions.get(SESSION_A)?.editorInjection?.text).toBe(
      "injected",
    );
    store.clearEditorInjection(SESSION_A);
    expect(useSessionsStore.getState().sessions.get(SESSION_A)?.editorInjection).toBeUndefined();
  });

  it("clearEditorInjection is a no-op when nothing is injected (same ref)", () => {
    const store = useSessionsStore.getState();
    store.createSession(SESSION_A, WORKSPACE, "/f/a.jsonl");
    const before = useSessionsStore.getState().sessions;
    store.clearEditorInjection(SESSION_A);
    expect(useSessionsStore.getState().sessions).toBe(before);
  });

  it("addUserMessage clears a stale editorInjection so it won't re-fire on remount", () => {
    const store = useSessionsStore.getState();
    store.createSession(SESSION_A, WORKSPACE, "/f/a.jsonl");
    store.injectEditorText(SESSION_A, "injected");
    // User typed over it then sent — the injection is consumed.
    store.setSessionDraft(SESSION_A, "world");
    store.addUserMessage(SESSION_A, "world");
    expect(useSessionsStore.getState().sessions.get(SESSION_A)?.editorInjection).toBeUndefined();
    expect(useSessionsStore.getState().sessionDrafts.has(SESSION_A)).toBe(false);
  });
});

// ── Unified-TUI panel reducer ───────────────────────────────────────────────
// The persistent unified panel (factory setWidget) + its bounded replay buffer,
// kept distinct from the transient custom() overlay panel so the two never
// collide and extensionUiActive doesn't treat the unified panel as blocking.

describe("sessions store - unified TUI panel reducer", () => {
  beforeEach(() => {
    useSessionsStore.setState({
      sessions: new Map(),
      activeSessionId: null,
      workspaces: new Map(),
      activeWorkspacePath: null,
    });
    useSessionsStore.getState().createSession(SESSION_A, WORKSPACE);
  });

  const unifiedPanel = (id: SessionId = SESSION_A) =>
    useSessionsStore.getState().sessions.get(id)?.unifiedPanel;
  const customPanel = (id: SessionId = SESSION_A) =>
    useSessionsStore.getState().sessions.get(id)?.panel;

  it("panel_open with unified:true creates a unifiedPanel, not a custom panel", () => {
    useSessionsStore.getState().handlePanelEvent(SESSION_A, {
      type: "panel_open",
      panelId: 7,
      overlay: false,
      unified: true,
    });
    expect(unifiedPanel()).toEqual({
      id: 7,
      hostInstanceId: "",
      sessionEpoch: 0,
      buffer: [],
    });
    expect(customPanel()).toBeUndefined();
  });

  it("panel_open without unified still creates the transient custom panel", () => {
    useSessionsStore.getState().handlePanelEvent(SESSION_A, {
      type: "panel_open",
      panelId: 3,
      overlay: true,
    });
    expect(unifiedPanel()).toBeUndefined();
    expect(customPanel()).toEqual({
      id: 3,
      overlay: true,
      hostInstanceId: "",
      sessionEpoch: 0,
      buffer: [],
    });
  });

  it("panel_data routes to the unifiedPanel buffer when its id matches", () => {
    const s = useSessionsStore.getState();
    s.handlePanelEvent(SESSION_A, {
      type: "panel_open",
      panelId: 7,
      overlay: false,
      unified: true,
    });
    s.handlePanelEvent(SESSION_A, { type: "panel_data", panelId: 7, data: "frame1" });
    expect(unifiedPanel()?.buffer).toEqual(["frame1"]);
  });

  it("panel_data caps the unified buffer at PANEL_BUFFER_MAX_BYTES", () => {
    const s = useSessionsStore.getState();
    s.handlePanelEvent(SESSION_A, {
      type: "panel_open",
      panelId: 7,
      overlay: false,
      unified: true,
    });
    const chunk = "x".repeat(300 * 1024);
    for (let i = 0; i < 4; i++) {
      s.handlePanelEvent(SESSION_A, { type: "panel_data", panelId: 7, data: chunk });
    }
    const buf = unifiedPanel()?.buffer ?? [];
    const total = buf.reduce((n, c) => n + c.length, 0);
    expect(total).toBeLessThanOrEqual(PANEL_BUFFER_MAX_BYTES);
    expect(buf.length).toBeGreaterThan(0);
  });

  it("panel_data drops stale unified replay history before the latest full-screen clear", () => {
    const s = useSessionsStore.getState();
    s.handlePanelEvent(SESSION_A, {
      type: "panel_open",
      panelId: 7,
      overlay: false,
      unified: true,
    });
    s.handlePanelEvent(SESSION_A, { type: "panel_data", panelId: 7, data: "old-first-frame" });
    s.handlePanelEvent(SESSION_A, { type: "panel_data", panelId: 7, data: "old-diff" });
    s.handlePanelEvent(SESSION_A, {
      type: "panel_data",
      panelId: 7,
      data: "\x1b[?2026h\x1b[2J\x1b[H\x1b[3Jnew-full-frame\x1b[?2026l",
    });
    s.handlePanelEvent(SESSION_A, { type: "panel_data", panelId: 7, data: "new-diff" });

    expect(unifiedPanel()?.buffer).toEqual([
      "\x1b[2J\x1b[H\x1b[3Jnew-full-frame\x1b[?2026l",
      "new-diff",
    ]);
  });

  it("panel_close clears the matching unifiedPanel", () => {
    const s = useSessionsStore.getState();
    s.handlePanelEvent(SESSION_A, {
      type: "panel_open",
      panelId: 7,
      overlay: false,
      unified: true,
    });
    s.handlePanelEvent(SESSION_A, { type: "panel_close", panelId: 7 });
    expect(unifiedPanel()).toBeUndefined();
  });

  it("unified_panel_reset drops stale unified-panel state (host gone on /reload)", () => {
    const s = useSessionsStore.getState();
    s.handlePanelEvent(SESSION_A, {
      type: "panel_open",
      panelId: 7,
      overlay: false,
      unified: true,
    });
    expect(nextPanelSequence(7)).toBe(1);
    s.handlePanelEvent(SESSION_A, { type: "unified_panel_reset" });
    expect(unifiedPanel()).toBeUndefined();
    s.handlePanelEvent(SESSION_A, {
      type: "panel_open",
      panelId: 7,
      overlay: false,
      unified: true,
    });
    expect(nextPanelSequence(7)).toBe(1);
  });

  it("panel_clear_all clears custom panels but NOT the unified panel", () => {
    const s = useSessionsStore.getState();
    s.handlePanelEvent(SESSION_A, {
      type: "panel_open",
      panelId: 7,
      overlay: false,
      unified: true,
    });
    s.handlePanelEvent(SESSION_A, { type: "panel_open", panelId: 3, overlay: true });
    s.handlePanelEvent(SESSION_A, { type: "panel_clear_all" });
    expect(unifiedPanel()?.id).toBe(7); // unified survives
    expect(customPanel()).toBeUndefined(); // custom cleared
  });

  // ── View toggle (Composer ⇄ unified TUI) ───────────────────────────────
  it("a fresh unified panel opens visible (unifiedPanelHidden false)", () => {
    useSessionsStore.getState().handlePanelEvent(SESSION_A, {
      type: "panel_open",
      panelId: 7,
      overlay: false,
      unified: true,
    });
    expect(useSessionsStore.getState().sessions.get(SESSION_A)?.unifiedPanelHidden).toBe(false);
  });

  it("setUnifiedPanelHidden flips the toggle while keeping the panel live", () => {
    const s = useSessionsStore.getState();
    s.handlePanelEvent(SESSION_A, {
      type: "panel_open",
      panelId: 7,
      overlay: false,
      unified: true,
    });
    s.setUnifiedPanelHidden(SESSION_A, true);
    expect(useSessionsStore.getState().sessions.get(SESSION_A)?.unifiedPanelHidden).toBe(true);
    expect(unifiedPanel()?.id).toBe(7); // panel still live, just not rendered
    s.setUnifiedPanelHidden(SESSION_A, false);
    expect(useSessionsStore.getState().sessions.get(SESSION_A)?.unifiedPanelHidden).toBe(false);
  });

  it("setUnifiedPanelHidden is a no-op when no unified panel is live", () => {
    // Guards a stale `hidden` flag from suppressing a future panel.
    useSessionsStore.getState().setUnifiedPanelHidden(SESSION_A, true);
    expect(useSessionsStore.getState().sessions.get(SESSION_A)?.unifiedPanelHidden).toBeUndefined();
  });

  it("re-opening a unified panel after closing resets the toggle to visible", () => {
    const s = useSessionsStore.getState();
    s.handlePanelEvent(SESSION_A, {
      type: "panel_open",
      panelId: 7,
      overlay: false,
      unified: true,
    });
    s.setUnifiedPanelHidden(SESSION_A, true);
    s.handlePanelEvent(SESSION_A, { type: "panel_close", panelId: 7 });
    // closed → flag reset
    expect(useSessionsStore.getState().sessions.get(SESSION_A)?.unifiedPanelHidden).toBe(false);
    s.handlePanelEvent(SESSION_A, {
      type: "panel_open",
      panelId: 8,
      overlay: false,
      unified: true,
    });
    // fresh panel starts visible regardless of the prior toggle
    expect(useSessionsStore.getState().sessions.get(SESSION_A)?.unifiedPanelHidden).toBe(false);
  });
});

describe("sessions store - historical cache notices", () => {
  const invokeMock = vi.fn();
  const originalWindow = (globalThis as { window?: unknown }).window;

  beforeEach(() => {
    useSessionsStore.setState({
      sessions: new Map(),
      activeSessionId: null,
      workspaces: new Map(),
      activeWorkspacePath: null,
      diffComments: new Map(),
    });
    invokeMock.mockReset();
    invokeMock.mockImplementation(
      async (channel: string, payload: { queryId?: string; query?: { type: string } }) => {
        if (channel !== "session.query") return {};
        return {
          queryId: payload.queryId,
          owner: { hostInstanceId: "host-1", sessionEpoch: 1 },
          queryType: payload.query?.type,
          response: {
            success: true,
            data: {
              notices: [
                {
                  type: "cache_miss_notice",
                  noticeId: "cache-miss-history",
                  afterEntryId: "assistant-1",
                  missedTokens: 25_000,
                  missedCost: 0.12,
                  idleMs: 0,
                  modelChanged: false,
                },
              ],
            },
          },
        };
      },
    );
    (globalThis as { window: unknown }).window = {
      pivis: { invoke: invokeMock, on: vi.fn(() => () => {}) },
    };
  });

  afterEach(() => {
    if (originalWindow === undefined) {
      delete (globalThis as { window?: unknown }).window;
    } else {
      (globalThis as { window: unknown }).window = originalWindow;
    }
  });

  it("replays notices after a cold history reaches ready", async () => {
    useSessionsStore
      .getState()
      .createSession(SESSION_A, WORKSPACE, "/tmp/session.jsonl", undefined, undefined, "cold");
    useSessionsStore.getState().seedHistory(SESSION_A, [
      { id: "assistant-1", type: "assistant", data: { role: "assistant", content: "Done" } },
      { id: "user-2", type: "user", data: { content: "Next" } },
    ]);
    expect(invokeMock).not.toHaveBeenCalled();

    installAuthority();

    await vi.waitFor(() => {
      const session = useSessionsStore.getState().sessions.get(SESSION_A);
      expect(
        session ? allTranscriptBlocks(session.transcript).map((block) => block.id) : undefined,
      ).toEqual(["assistant-1", "cache-miss-history", "user-2"]);
    });
    expect(invokeMock).toHaveBeenCalledWith(
      "session.query",
      expect.objectContaining({
        sessionId: SESSION_A,
        query: { type: "get_cache_miss_notices" },
        expectedOwner: { hostInstanceId: "host-1", sessionEpoch: 1 },
      }),
    );
  });
});

describe("sessions store - explicit close review", () => {
  it("shows the actual checkpoint before force-closing", async () => {
    const confirm = vi.fn((_message: string) => true);
    const invoke = vi.fn(async (channel: string) => {
      if (channel === "session.prepareClose") {
        return {
          reviewToken: "close-token",
          checkpoint: {
            editor: { text: "host-owned draft" },
            intents: [{ disposition: "outcome_unknown", text: "ambiguous prompt" }],
            restorations: [],
            dialogs: [],
            panels: [],
          },
        };
      }
      if (channel === "session.cancelClose") return { cancelled: true };
      if (channel === "session.confirmClose") return { closed: true };
      return {};
    });
    vi.stubGlobal("window", { pivis: { invoke }, confirm });
    useSessionsStore.setState({ sessions: new Map(), activeSessionId: null });
    const store = useSessionsStore.getState();
    store.createSession(SESSION_A, WORKSPACE);
    store.setSessionDraft(SESSION_A, "renderer-owned draft");

    await store.closeSessionTab(SESSION_A);

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0]?.[0]).toContain("host-owned draft");
    expect(confirm.mock.calls[0]?.[0]).toContain("renderer-owned draft");
    expect(confirm.mock.calls[0]?.[0]).toContain("ambiguous prompt");
    expect(confirm.mock.calls[0]?.[0]).toContain("permanently discards");
  });

  it("requires close review for an attachment-only editor conflict", async () => {
    const confirm = vi.fn((_message: string) => false);
    const invoke = vi.fn(async (channel: string) => {
      if (channel === "session.prepareClose") {
        return {
          reviewToken: "close-token",
          checkpoint: {
            editor: {
              text: "",
              attachments: [],
              conflictText: "",
              conflictAttachments: [{ kind: "file", name: "local-only.txt" }],
            },
            intents: [],
            restorations: [],
            dialogs: [],
            panels: [],
          },
        };
      }
      if (channel === "session.cancelClose") return { cancelled: true };
      return {};
    });
    vi.stubGlobal("window", { pivis: { invoke }, confirm });
    useSessionsStore.setState({ sessions: new Map(), activeSessionId: null });
    useSessionsStore.getState().createSession(SESSION_A, WORKSPACE);

    await useSessionsStore.getState().closeSessionTab(SESSION_A);

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0]?.[0]).toContain("local-only.txt");
    expect(invoke).toHaveBeenCalledWith("session.cancelClose", {
      sessionId: SESSION_A,
      reviewToken: "close-token",
    });
  });
});

describe("sessions store - queue restoration", () => {
  it("retains an attachment-only pending session across switching", () => {
    const invoke = vi.fn(async () => ({}));
    vi.stubGlobal("window", { pivis: { invoke } });
    useSessionsStore.setState({ sessions: new Map(), activeSessionId: null });
    const store = useSessionsStore.getState();
    store.createSession(SESSION_A, WORKSPACE);
    store.createSession(SESSION_B, WORKSPACE, "/tmp/existing.jsonl");
    store.beginEditorAttachmentRead(SESSION_A);
    const session = useSessionsStore.getState().sessions.get(SESSION_A);
    expect(sessionHasHistory(session)).toBe(false);
    expect(isNewSessionPending(session)).toBe(true);
    store.setActiveSession(SESSION_A);
    store.setActiveSession(SESSION_B);
    expect(useSessionsStore.getState().sessions.has(SESSION_A)).toBe(true);
    expect(useSessionsStore.getState().sessions.get(SESSION_A)?.editorAttachmentReads).toBe(1);
    expect(invoke).not.toHaveBeenCalledWith(
      "session.prepareClose",
      expect.objectContaining({ sessionId: SESSION_A }),
    );
    store.endEditorAttachmentRead(SESSION_A);
    store.stageEditorAttachments(SESSION_A, [
      { kind: "file", name: "notes.txt", path: "/tmp/notes.txt" },
    ]);
    expect(useSessionsStore.getState().sessions.get(SESSION_A)?.editorAttachments).toHaveLength(1);
  });

  it("acknowledges an empty custody marker without showing an empty review card", async () => {
    const invoke = vi.fn(async () => ({ acknowledged: true }));
    vi.stubGlobal("window", { pivis: { invoke } });
    useSessionsStore.setState({ sessions: new Map(), activeSessionId: null });
    const store = useSessionsStore.getState();
    store.createSession(SESSION_A, WORKSPACE);

    store.applyQueueRestoration(SESSION_A, {
      restorationId: "restore-empty",
      steering: [],
      followUp: [],
      originalAttachments: [{ intentId: "empty-intent", images: [] }],
    });

    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("session.acknowledgeRestoration", {
        sessionId: SESSION_A,
        restorationId: "restore-empty",
      }),
    );
    expect(useSessionsStore.getState().sessions.get(SESSION_A)?.queueRestorations).toBeUndefined();
    expect(useSessionsStore.getState().sessions.get(SESSION_A)?.toasts).toEqual([]);
  });

  it("transfers cleared optimistic ownership to the restoration review", () => {
    vi.stubGlobal("window", { pivis: { invoke: vi.fn(async () => ({})) } });
    useSessionsStore.setState({ sessions: new Map(), activeSessionId: null });
    const store = useSessionsStore.getState();
    store.createSession(SESSION_A, WORKSPACE);
    store.addUserMessage(SESSION_A, "original", undefined, {
      registerEcho: true,
      afterUserMessageSequence: 0,
      intentId: "cleared-intent",
    });

    store.applyQueueRestoration(SESSION_A, {
      restorationId: "restore-cleared",
      steering: ["transformed queued"],
      followUp: [],
      originalAttachments: [],
      clearedIntentIds: ["cleared-intent"],
    });

    const session = useSessionsStore.getState().sessions.get(SESSION_A)!;
    expect(session.transcript.blocks).toEqual([]);
    expect(session.transcript.pendingEchoes).toEqual([]);
    expect(session.queueRestorations).toEqual([
      expect.objectContaining({ restorationId: "restore-cleared" }),
    ]);
  });

  it("retains an ambiguous command marker without auto-restoring executable text", () => {
    const invoke = vi.fn(async () => ({ acknowledged: true }));
    vi.stubGlobal("window", { pivis: { invoke } });
    useSessionsStore.setState({ sessions: new Map(), activeSessionId: null });
    const store = useSessionsStore.getState();
    store.createSession(SESSION_A, WORKSPACE);

    store.applyQueueRestoration(SESSION_A, {
      restorationId: "ambiguous-command:intent-1",
      steering: [],
      followUp: ["!touch marker"],
      originalAttachments: [],
      commandDescription: "bash may have completed before acknowledgement was lost.",
    });

    const session = useSessionsStore.getState().sessions.get(SESSION_A);
    expect(session?.queueRestorations).toEqual([
      expect.objectContaining({
        restorationId: "ambiguous-command:intent-1",
        commandDescription: expect.stringContaining("bash may have completed"),
      }),
    ]);
    expect(session?.editorInjection).toBeUndefined();
    expect(invoke).not.toHaveBeenCalledWith("session.acknowledgeRestoration", expect.anything());
  });

  it("keeps original attachments separate and labels restoration for review", () => {
    useSessionsStore.setState({ sessions: new Map(), activeSessionId: null });
    useSessionsStore.getState().createSession(SESSION_A, WORKSPACE);

    useSessionsStore.getState().applyQueueRestoration(SESSION_A, {
      restorationId: "restore-1",
      steering: ["queued text"],
      followUp: [],
      originalAttachments: [
        { intentId: "intent-1", images: [{ mimeType: "image/png", data: "base64" }] },
      ],
    });

    const session = useSessionsStore.getState().sessions.get(SESSION_A);
    expect(session?.editorInjection?.text).toBe("queued text");
    expect(session?.queueRestorations).toEqual([
      {
        restorationId: "restore-1",
        steering: ["queued text"],
        followUp: [],
        originalAttachments: [
          { intentId: "intent-1", images: [{ mimeType: "image/png", data: "base64" }] },
        ],
      },
    ]);
    expect(session?.toasts.at(-1)?.message).toContain("original attachments");
  });

  it("deduplicates replay and never overwrites newer draft text", () => {
    useSessionsStore.setState({ sessions: new Map(), activeSessionId: null });
    const store = useSessionsStore.getState();
    store.createSession(SESSION_A, WORKSPACE);
    store.setSessionDraft(SESSION_A, "newer typing");
    const restoration = {
      restorationId: "restore-replay",
      steering: [],
      followUp: ["old restored text"],
      originalAttachments: [],
    };

    store.applyQueueRestoration(SESSION_A, restoration);
    const afterFirst = useSessionsStore.getState().sessions.get(SESSION_A);
    expect(afterFirst?.editorInjection).toBeUndefined();
    store.applyQueueRestoration(SESSION_A, restoration);

    expect(useSessionsStore.getState().sessions.get(SESSION_A)?.queueRestorations).toHaveLength(1);
    expect(useSessionsStore.getState().sessionDrafts.get(SESSION_A)).toBe("newer typing");
  });

  it("retires a reviewed restoration through main acknowledgement", async () => {
    const invoke = vi.fn(async () => ({ acknowledged: true }));
    vi.stubGlobal("window", { pivis: { invoke } });
    useSessionsStore.setState({ sessions: new Map(), activeSessionId: null });
    const store = useSessionsStore.getState();
    store.createSession(SESSION_A, WORKSPACE);
    store.applyQueueRestoration(SESSION_A, {
      restorationId: "restore-dismiss",
      steering: [],
      followUp: ["text"],
      originalAttachments: [],
    });

    await store.dismissQueueRestoration(SESSION_A, "restore-dismiss");

    expect(invoke).toHaveBeenCalledWith("session.acknowledgeRestoration", {
      sessionId: SESSION_A,
      restorationId: "restore-dismiss",
    });
    expect(useSessionsStore.getState().sessions.get(SESSION_A)?.queueRestorations).toEqual([]);
  });
});

// ── Unified-TUI submit pipeline (handleUnifiedSubmitRequest) ────────────────
// Pins parity with the React Composer's submit: the same parse → no-model
// guard → executeAction path, plus the host round-trip reply (ok / bailed) so
// the TUI editor can restore on a guard bail. Runs under a node env, so we
// stand up a minimal window.pivis.

describe("sessions store - unified TUI submit (handleUnifiedSubmitRequest)", () => {
  const invokeMock = vi.fn();
  const originalWindow = (globalThis as { window?: unknown }).window;

  beforeEach(() => {
    useSessionsStore.setState({
      sessions: new Map(),
      activeSessionId: null,
      workspaces: new Map(),
      activeWorkspacePath: null,
      diffComments: new Map(),
    });
    useSessionsStore.getState().createSession(SESSION_A, WORKSPACE);
    // Unified submission requires both available transport and an authority baseline.
    installAuthority();
    invokeMock.mockReset();
    invokeMock.mockImplementation(async (channel: string, payload?: unknown) => {
      if (channel === "session.claimUnifiedSubmit") return claimedUnified();
      if (channel === "session.dispatchIntent") {
        const envelope = payload as IntentEnvelope;
        queueMicrotask(() => publishIntentOutcome(envelope));
        return {
          status: "admitted" as const,
          intentId: envelope.intentId,
          owner: { hostInstanceId: "host-1", sessionEpoch: 1 },
        };
      }
      return { success: true };
    });
    (globalThis as { window: unknown }).window = {
      pivis: { invoke: invokeMock, on: vi.fn(() => () => {}) },
      dispatchEvent: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
  });

  afterEach(() => {
    if (originalWindow === undefined) {
      delete (globalThis as { window?: unknown }).window;
    } else {
      (globalThis as { window: unknown }).window = originalWindow;
    }
  });

  const lastUnifiedResponse = () => {
    const calls = invokeMock.mock.calls.filter((c) => c[0] === "session.unifiedSubmitResponse");
    return calls.at(-1)?.[1] as
      | { id?: string; ok?: boolean; bailed?: boolean; error?: string }
      | undefined;
  };
  const sentCommandType = (t: string) =>
    invokeMock.mock.calls.some((call) => {
      if (call[0] === "session.query") {
        return (call[1] as { query?: { type?: string } }).query?.type === t;
      }
      if (call[0] !== "session.dispatchIntent") return false;
      const kind = (call[1] as { intent?: { kind?: string } }).intent?.kind;
      return (
        (t === "prompt" && kind === "submit") ||
        (t === "bash" && kind === "runBash") ||
        (t === "invokeCommand" && kind === "invokeCommand")
      );
    });
  const sentIntent = () =>
    invokeMock.mock.calls.find((call) => call[0] === "session.dispatchIntent")?.[1] as
      | IntentEnvelope
      | undefined;
  const sentSubmission = () => {
    const envelope = invokeMock.mock.calls.find((c) => c[0] === "session.dispatchIntent")?.[1] as
      | {
          intentId: string;
          intent: {
            kind: string;
            editorRevision: number;
            text: string;
            surface: string;
            images: Array<{ type: "image"; data: string; mimeType: string }>;
          };
        }
      | undefined;
    return envelope && envelope.intent.kind === "submit"
      ? { submission: { intentId: envelope.intentId, ...envelope.intent } }
      : undefined;
  };

  it("does not replay a unified action when main reports an existing execution claim", async () => {
    invokeMock.mockResolvedValueOnce({ claimed: false });

    await useSessionsStore
      .getState()
      .handleUnifiedSubmitRequest(
        SESSION_A,
        "claimed-action",
        "!touch marker",
        0,
        "intent-claimed",
        "host-1",
        1,
      );

    expect(sentCommandType("bash")).toBe(false);
    expect(lastUnifiedResponse()).toBeUndefined();
  });

  it("an empty submit bails without dispatching a prompt", async () => {
    await useSessionsStore
      .getState()
      .handleUnifiedSubmitRequest(SESSION_A, "id1", "   ", 0, "intent-id1", "host-1", 1);
    expect(lastUnifiedResponse()).toMatchObject({ id: "id1", ok: false, bailed: true });
    expect(sentCommandType("prompt")).toBe(false);
  });

  it("a comments-only submit sends the pending diff comments", async () => {
    useSessionsStore.getState().setCurrentModel(SESSION_A, "anthropic/claude");
    useSessionsStore.getState().setDiffComment(SESSION_A, {
      filePath: "src/a.ts",
      lineNumber: 42,
      lineText: "if (flag) return a;",
      text: "Please simplify this branch.",
    });

    await useSessionsStore
      .getState()
      .handleUnifiedSubmitRequest(
        SESSION_A,
        "id-comments",
        "   ",
        0,
        "intent-comments",
        "host-1",
        1,
      );

    expect(sentCommandType("prompt")).toBe(true);
    expect(sentSubmission()?.submission).toMatchObject({
      text: expect.stringContaining("### User comments on the code"),
      surface: "unified",
    });
    expect(sentSubmission()?.submission.text).toContain("File: src/a.ts");
    expect(sentSubmission()?.submission.text).toContain("Line: 42");
    expect(lastUnifiedResponse()).toMatchObject({ id: "id-comments", ok: true });
    expect(useSessionsStore.getState().getDiffCommentsForPrompt(SESSION_A)).toEqual([]);
  });

  it("does not prepend or clear staged comments for slash-command submissions", async () => {
    useSessionsStore.getState().setCurrentModel(SESSION_A, "anthropic/claude");
    useSessionsStore.setState((state) => {
      const sessions = new Map(state.sessions);
      sessions.set(SESSION_A, {
        ...sessions.get(SESSION_A)!,
        commands: [{ name: "widget-on", description: "Open widget", source: "extension" }],
        editorAttachments: [
          { kind: "file", name: "notes.txt", path: "/tmp/notes.txt" },
          {
            kind: "image",
            name: "diagram.png",
            path: "/tmp/diagram.png",
            dataUrl: "data:image/png;base64,eA==",
          },
        ],
      });
      return { sessions };
    });
    useSessionsStore.getState().setDiffComment(SESSION_A, {
      filePath: "src/a.ts",
      lineNumber: 42,
      lineText: "if (flag) return a;",
      text: "Please simplify this branch.",
    });

    await useSessionsStore
      .getState()
      .handleUnifiedSubmitRequest(
        SESSION_A,
        "id-slash-comments",
        "/widget-on",
        0,
        "intent-slash-comments",
        "host-1",
        1,
      );

    expect(sentIntent()?.intent).toMatchObject({
      kind: "invokeCommand",
      text: "/widget-on",
    });
    expect(lastUnifiedResponse()).toMatchObject({ id: "id-slash-comments", ok: true });
    expect(useSessionsStore.getState().getDiffCommentsForPrompt(SESSION_A)).toHaveLength(1);
    expect(useSessionsStore.getState().sessions.get(SESSION_A)?.editorAttachments).toHaveLength(2);
  });

  it("sends staged attachments and comments with a leading-whitespace ordinary prompt", async () => {
    useSessionsStore.setState((state) => {
      const sessions = new Map(state.sessions);
      sessions.set(SESSION_A, {
        ...sessions.get(SESSION_A)!,
        currentModel: "vision",
        availableModels: [{ id: "vision", name: "Vision", input: ["text", "image"] }],
        editorAttachments: [
          { kind: "file", name: "notes.txt", path: "/tmp/notes.txt" },
          {
            kind: "image",
            name: "diagram.png",
            path: "/tmp/diagram.png",
            dataUrl: "data:image/png;base64,eA==",
          },
        ],
      });
      return { sessions };
    });
    useSessionsStore.getState().setDiffComment(SESSION_A, {
      filePath: "src/a.ts",
      lineNumber: 42,
      lineText: "if (flag) return a;",
      text: "Please simplify this branch.",
    });

    await useSessionsStore
      .getState()
      .handleUnifiedSubmitRequest(
        SESSION_A,
        "id-leading-space",
        "  /tmp/file is relevant",
        0,
        "intent-leading-space",
        "host-1",
        1,
      );

    const submission = sentSubmission()?.submission;
    expect(submission?.text).toContain("  /tmp/file is relevant");
    expect(submission?.text).toContain("/tmp/notes.txt");
    expect(submission?.text).toContain("### User comments on the code");
    expect(submission?.images).toEqual([{ type: "image", data: "eA==", mimeType: "image/png" }]);
    expect(lastUnifiedResponse()).toMatchObject({ id: "id-leading-space", ok: true });
    expect(useSessionsStore.getState().getDiffCommentsForPrompt(SESSION_A)).toEqual([]);
  });

  it("a send-prompt with no model bails + toasts (no-model guard parity)", async () => {
    publishSemantic(SESSION_A, 2, semanticSnapshot(2, { model: null }));
    await useSessionsStore
      .getState()
      .handleUnifiedSubmitRequest(SESSION_A, "id2", "hello", 0, "intent-id2", "host-1", 1);
    expect(lastUnifiedResponse()).toMatchObject({
      id: "id2",
      ok: false,
      bailed: true,
      error: "No model selected",
    });
    expect(sentCommandType("prompt")).toBe(false);
    const toasts = useSessionsStore.getState().sessions.get(SESSION_A)?.toasts ?? [];
    expect(toasts.at(-1)).toMatchObject({ type: "error", message: "No model selected" });
  });

  it("a valid prompt waits for host consumption before adding an echo and replying ok:true", async () => {
    useSessionsStore.getState().setCurrentModel(SESSION_A, "anthropic/claude");
    let resolveSubmission!: (result: {
      status: "admitted";
      intentId: string;
      owner: { hostInstanceId: string; sessionEpoch: number };
    }) => void;
    invokeMock.mockImplementation((channel: string) => {
      if (channel === "session.claimUnifiedSubmit") return Promise.resolve(claimedUnified());
      if (channel === "session.dispatchIntent") {
        return new Promise((resolve) => {
          resolveSubmission = resolve;
        });
      }
      return Promise.resolve({ success: true });
    });

    const request = useSessionsStore
      .getState()
      .handleUnifiedSubmitRequest(SESSION_A, "id3", "hello world", 41, "intent-id3", "host-1", 1);
    await vi.waitFor(() => expect(sentSubmission()).toBeDefined());
    expect(sentCommandType("prompt")).toBe(true);
    // There is no pre-custody optimistic transcript bubble.
    expect(useSessionsStore.getState().sessions.get(SESSION_A)?.transcript.blocks).toEqual([]);

    const submission = sentSubmission()!.submission;
    expect(submission.intentId).toBe("intent-id3");
    expect(submission.editorRevision).toBe(41);
    const envelope = sentIntent()!;
    resolveSubmission({
      status: "admitted",
      intentId: submission.intentId,
      owner: { hostInstanceId: "host-1", sessionEpoch: 1 },
    });
    publishIntentOutcome(envelope);
    await request;

    expect(lastUnifiedResponse()).toMatchObject({ id: "id3", ok: true });
  });

  it("suppresses late unified continuation and acknowledgement after claim expiry", async () => {
    useSessionsStore.getState().setCurrentModel(SESSION_A, "anthropic/claude");
    let now = 1_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    let resolveSubmission!: (result: {
      status: "admitted";
      intentId: string;
      owner: { hostInstanceId: string; sessionEpoch: number };
    }) => void;
    invokeMock.mockImplementation((channel: string) => {
      if (channel === "session.claimUnifiedSubmit") {
        return Promise.resolve({ claimed: true, claimId: "expiring-claim", expiresAt: 1_010 });
      }
      if (channel === "session.dispatchIntent") {
        return new Promise((resolve) => {
          resolveSubmission = resolve;
        });
      }
      return Promise.resolve({ success: true });
    });

    const pending = useSessionsStore
      .getState()
      .handleUnifiedSubmitRequest(
        SESSION_A,
        "expiring",
        "do this once",
        9,
        "intent-expiring",
        "host-1",
        1,
      );
    await vi.waitFor(() => expect(sentSubmission()).toBeDefined());
    now = 1_020;
    resolveSubmission({
      status: "admitted",
      intentId: "intent-expiring",
      owner: { hostInstanceId: "host-1", sessionEpoch: 1 },
    });
    await pending;

    expect(lastUnifiedResponse()).toBeUndefined();
    expect(useSessionsStore.getState().sessions.get(SESSION_A)?.transcript.blocks).toEqual([]);
    nowSpy.mockRestore();
  });

  it("does not open a picker or toast after a claimed command continuation expires", async () => {
    let now = 2_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    let resolveCommand!: (result: unknown) => void;
    let queryPayload: { queryId: string; query: { type: string } } | undefined;
    invokeMock.mockImplementation((channel: string, payload?: unknown) => {
      if (channel === "session.claimUnifiedSubmit") {
        return Promise.resolve({ claimed: true, claimId: "fork-claim", expiresAt: 2_010 });
      }
      if (channel === "session.query") {
        queryPayload = payload as { queryId: string; query: { type: string } };
        return new Promise((resolve) => {
          resolveCommand = resolve;
        });
      }
      return Promise.resolve({ success: true });
    });

    const pending = useSessionsStore
      .getState()
      .handleUnifiedSubmitRequest(
        SESSION_A,
        "expiring-fork",
        "/fork",
        0,
        "intent-fork",
        "host-1",
        1,
      );
    await vi.waitFor(() => expect(sentCommandType("get_fork_messages")).toBe(true));
    now = 2_020;
    resolveCommand({
      queryId: queryPayload!.queryId,
      owner: { hostInstanceId: "host-1", sessionEpoch: 1 },
      queryType: "get_fork_messages",
      response: {
        success: true,
        command: "get_fork_messages",
        data: { messages: [{ entryId: "entry-1", text: "fork me" }] },
      },
    });
    await pending;

    const session = useSessionsStore.getState().sessions.get(SESSION_A);
    expect(session?.pendingPicker).toBeUndefined();
    expect(session?.toasts).toEqual([]);
    expect(lastUnifiedResponse()).toBeUndefined();
    nowSpy.mockRestore();
  });

  it("a prompt send failure replies bailed so the host restores unified editor text", async () => {
    useSessionsStore.getState().setCurrentModel(SESSION_A, "anthropic/claude");
    invokeMock.mockImplementation(async (channel: string, payload?: unknown) => {
      if (channel === "session.claimUnifiedSubmit") return claimedUnified();
      if (channel === "session.dispatchIntent") {
        const envelope = payload as { intentId: string };
        return {
          status: "not_admitted" as const,
          reason: "invalid",
          intentId: envelope.intentId,
          owner: { hostInstanceId: "host-1", sessionEpoch: 1 },
        };
      }
      return { success: true };
    });

    await useSessionsStore
      .getState()
      .handleUnifiedSubmitRequest(SESSION_A, "id-fail", "hello", 0, "intent-fail", "host-1", 1);

    expect(sentCommandType("prompt")).toBe(true);
    expect(sentSubmission()?.submission.text).toBe("hello");
    expect(lastUnifiedResponse()).toMatchObject({
      id: "id-fail",
      ok: false,
      bailed: true,
      error: "Intent was not admitted: invalid",
    });
    const toasts = useSessionsStore.getState().sessions.get(SESSION_A)?.toasts ?? [];
    expect(toasts.at(-1)).toMatchObject({
      type: "warning",
      message: "Intent was not admitted: invalid",
    });
  });

  it("a bash command (!prefix) bypasses the no-model guard and dispatches", async () => {
    // no currentModel set — bash must still go through (Composer parity)
    await useSessionsStore
      .getState()
      .handleUnifiedSubmitRequest(SESSION_A, "id4", "!ls -la", 0, "intent-id4", "host-1", 1);
    expect(sentCommandType("bash")).toBe(true);
    expect(lastUnifiedResponse()).toMatchObject({ id: "id4", ok: true });
  });
});

// ── adoptSessionFileAndHydrate (unified TUI / Composer parity) ─────────────
// Regression guard for the bug where the unified-TUI submit path wired the
// BARE adoptSessionFile (no history load, no sidebar refresh), so /fork,
// /clone, /switch_session, /resume from the TUI left a blank transcript.

describe("sessions store - adoptSessionFileAndHydrate", () => {
  const invokeMock = vi.fn();
  const originalWindow = (globalThis as { window?: unknown }).window;

  beforeEach(() => {
    useSessionsStore.setState({
      sessions: new Map(),
      activeSessionId: null,
      workspaces: new Map(),
      activeWorkspacePath: null,
    });
    useSessionsStore.getState().createSession(SESSION_A, WORKSPACE);
    invokeMock.mockReset();
    invokeMock.mockImplementation((channel: string, payload?: unknown) => {
      if (channel === "session.loadHistory") {
        return Promise.resolve(loadedHistory(payload, []));
      }
      return Promise.resolve({ success: true });
    });
    (globalThis as { window: unknown }).window = {
      pivis: { invoke: invokeMock, on: vi.fn(() => () => {}) },
      dispatchEvent: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
  });

  afterEach(() => {
    if (originalWindow === undefined) {
      delete (globalThis as { window?: unknown }).window;
    } else {
      (globalThis as { window: unknown }).window = originalWindow;
    }
  });

  it("adopts the file, loads transcript history, and refreshes the workspace session list", async () => {
    await useSessionsStore
      .getState()
      .adoptSessionFileAndHydrate(SESSION_A, "/new/session.jsonl", "Forked");
    const s = useSessionsStore.getState().sessions.get(SESSION_A);
    expect(s?.sessionFile).toBe("/new/session.jsonl");
    expect(s?.sessionName).toBeUndefined();
    expect(invokeMock).toHaveBeenCalledWith(
      "session.loadHistory",
      expect.objectContaining({
        sessionId: SESSION_A,
        expectedSessionFile: "/new/session.jsonl",
        historyGeneration: expect.any(Number),
      }),
    );
    expect(invokeMock).toHaveBeenCalledWith("workspace.listSessions", { workspacePath: WORKSPACE });
  });

  it("skips history/refresh when no file is adopted", async () => {
    await useSessionsStore.getState().adoptSessionFileAndHydrate(SESSION_A, undefined);
    expect(invokeMock).not.toHaveBeenCalledWith("session.loadHistory", expect.anything());
    expect(invokeMock).not.toHaveBeenCalledWith("workspace.listSessions", expect.anything());
  });

  it("preserves the acknowledged successor runtime while adopting its file", async () => {
    const runtime = runtimeState(false);
    const identity = {
      hostInstanceId: runtime.snapshot!.hostInstanceId,
      sessionEpoch: runtime.snapshot!.sessionEpoch,
    };
    useSessionsStore.getState().applyRuntimeState(SESSION_A, runtime);
    useSessionsStore.getState().setSessionStatus(SESSION_A, "ready");

    await useSessionsStore
      .getState()
      .adoptSessionFileAndHydrate(SESSION_A, "/new/session.jsonl", "Forked", identity);

    const session = useSessionsStore.getState().sessions.get(SESSION_A);
    expect(session?.availability).toBe("available");
    expect(session?.runtimeSnapshot).toEqual(runtime.snapshot);
  });

  it("rereads initial history when a transcript event arrives during hydration", async () => {
    const historyRequests: Array<{
      payload: unknown;
      resolve: (history: ReturnType<typeof loadedHistory>) => void;
    }> = [];
    invokeMock.mockImplementation((channel: string, payload?: unknown) => {
      if (channel === "session.loadHistory") {
        return new Promise((resolve) => historyRequests.push({ payload, resolve }));
      }
      return Promise.resolve({ success: true });
    });

    const pending = useSessionsStore
      .getState()
      .adoptSessionFileAndHydrate(SESSION_A, "/new/session.jsonl", "Forked");
    await vi.waitFor(() => expect(historyRequests).toHaveLength(1));
    useSessionsStore.getState().applyEvent(SESSION_A, {
      type: "message_start",
      message: { role: "user", content: "racing event" },
    });
    historyRequests[0]!.resolve(
      loadedHistory(historyRequests[0]!.payload, [
        { id: "persisted-race", type: "user", data: { content: "racing event" } },
      ]),
    );

    await vi.waitFor(() => expect(historyRequests).toHaveLength(2));
    historyRequests[1]!.resolve(
      loadedHistory(historyRequests[1]!.payload, [
        { id: "persisted-race", type: "user", data: { content: "racing event" } },
      ]),
    );
    await pending;

    const transcript = useSessionsStore.getState().sessions.get(SESSION_A)!.transcript;
    expect(allTranscriptBlocks(transcript)).toEqual([
      expect.objectContaining({ id: "persisted-race", type: "user" }),
    ]);
  });

  it("does not seed delayed predecessor history across a later runtime generation", async () => {
    const identity = { hostInstanceId: "host-1", sessionEpoch: 1 };
    useSessionsStore.getState().applyAuthorityAttach(SESSION_A, authorityAttach());
    useSessionsStore.getState().setSessionStatus(SESSION_A, "ready");
    let historyPayload: unknown;
    let resolveHistory!: (history: ReturnType<typeof loadedHistory>) => void;
    invokeMock.mockImplementation((channel: string, payload?: unknown) => {
      if (channel === "session.loadHistory") {
        historyPayload = payload;
        return new Promise((resolve) => {
          resolveHistory = resolve;
        });
      }
      return Promise.resolve({ success: true });
    });

    const pending = useSessionsStore
      .getState()
      .adoptSessionFileAndHydrate(SESSION_A, "/new/session.jsonl", "Forked", identity);
    await vi.waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith(
        "session.loadHistory",
        expect.objectContaining({
          sessionId: SESSION_A,
          expectedSessionFile: "/new/session.jsonl",
          expectedHostInstanceId: identity.hostInstanceId,
          expectedSessionEpoch: identity.sessionEpoch,
        }),
      ),
    );
    const successor = authorityAttach(
      semanticSnapshot(1, { owner: { hostInstanceId: "host-2", sessionEpoch: 2 } }),
    );
    successor.baseline.publicationHighWatermark = 1;
    useSessionsStore.getState().applyAuthorityAttach(SESSION_A, successor);
    useSessionsStore.getState().addCustomMessage(SESSION_A, "new-runtime-content");
    resolveHistory(
      loadedHistory(historyPayload, [
        { id: "old-history", type: "user", data: { content: "stale" } },
      ]),
    );
    await pending;

    const blocks = useSessionsStore.getState().sessions.get(SESSION_A)?.transcript.blocks ?? [];
    expect(blocks.some((block) => block.id === "old-history")).toBe(false);
    expect(blocks.some((block) => block.type === "custom_message")).toBe(true);
  });
});

// ── S1/S2 turn-end truth table + abortSession contract (ESC-to-interrupt) ──
// Pins that isStreaming clears at every definitive turn end (final agent_end,
// terminal SessionStatus, rejected/failed prompt send) and never gets stuck
// true; and that abortSession is a no-op when idle + rejection-safe.

describe("sessions store - host-authoritative escape", () => {
  const invokeMock = vi.fn();
  beforeEach(() => {
    useSessionsStore.setState({
      sessions: new Map(),
      activeSessionId: null,
      workspaces: new Map(),
      activeWorkspacePath: null,
    });
    useSessionsStore.getState().createSession(SESSION_A, WORKSPACE);
    invokeMock.mockResolvedValue({ disposition: "already_inactive" });
    vi.stubGlobal("window", { pivis: { invoke: invokeMock } });
  });

  it("does not dispatch escape from an unavailable runtime", () => {
    useSessionsStore.getState().applyRuntimeState(SESSION_A, runtimeState(false, 1, "unavailable"));
    useSessionsStore.getState().abortSession(SESSION_A);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("binds escape to the currently available host and epoch", () => {
    installAuthority();
    useSessionsStore.getState().abortSession(SESSION_A);
    expect(invokeMock).toHaveBeenCalledWith(
      "session.dispatchIntent",
      expect.objectContaining({
        sessionId: SESSION_A,
        expectedOwner: { hostInstanceId: "host-1", sessionEpoch: 1 },
        intent: { kind: "interrupt" },
      }),
    );
  });
});

describe("sessions store - clearPendingUserEcho (failed optimistic send)", () => {
  beforeEach(() => {
    useSessionsStore.setState({
      sessions: new Map(),
      activeSessionId: null,
      workspaces: new Map(),
      activeWorkspacePath: null,
      newSessionDrafts: new Map(),
      sessionDrafts: new Map(),
    });
    useSessionsStore.getState().createSession(SESSION_A, WORKSPACE);
  });

  it("brand-new session: removes the bubble, restores the workspace draft, and re-marks pending", () => {
    const store = useSessionsStore.getState();
    // The very first prompt of a brand-new (non-resumed) session is sent
    // optimistically, then the send fails before pi echoes it.
    store.addUserMessage(SESSION_A, "first prompt");
    expect(useSessionsStore.getState().sessions.get(SESSION_A)?.transcript.blocks).toHaveLength(1);

    store.clearPendingUserEcho(SESSION_A, "first prompt");

    const after = useSessionsStore.getState();
    // Optimistic bubble is gone...
    expect(after.sessions.get(SESSION_A)?.transcript.blocks).toHaveLength(0);
    // ...the text is handed back as the workspace's new-session draft...
    expect(after.newSessionDrafts.get(WORKSPACE)).toBe("first prompt");
    // ...and the session is re-marked pending so the composer shows new-session UI.
    expect(after.sessions.get(SESSION_A)?.isNewPending).toBe(true);
  });

  it("established session: overwrites the per-session draft with the failed prompt (known clobber tradeoff)", () => {
    const store = useSessionsStore.getState();
    // Established session (has prior history), so the restore-to-new-session
    // path does not apply.
    store.addUserMessage(SESSION_A, "earlier message");
    store.addUserMessage(SESSION_A, "message A");
    // The user starts typing a NEW draft while "message A" is still in flight.
    store.setSessionDraft(SESSION_A, "draft typed after send");

    store.clearPendingUserEcho(SESSION_A, "message A");

    const after = useSessionsStore.getState();
    // The tail-most optimistic "message A" bubble is removed; history stands.
    const blocks = after.sessions.get(SESSION_A)?.transcript.blocks ?? [];
    expect(blocks).toHaveLength(1);
    if (blocks[0]?.type === "user") expect(blocks[0].data.content).toBe("earlier message");
    // KNOWN TRADEOFF: the failed content is written back as the session draft,
    // overwriting the newer text the user had begun typing. Low-frequency and
    // recoverable; pinned here so any change to this behavior is deliberate.
    expect(after.sessionDrafts.get(SESSION_A)).toBe("message A");
  });
});

function semanticSnapshot(
  sequence: number,
  overrides: Partial<SemanticSnapshot> = {},
): SemanticSnapshot {
  return {
    owner: { hostInstanceId: "host-1", sessionEpoch: 1 },
    snapshotSequence: sequence,
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
    model: { id: "model-old", provider: "provider" },
    thinkingLevel: "low",
    catalog: { notifications: [], statuses: {}, widgets: {}, capabilityDiagnostics: [] },
    ...overrides,
  };
}

function authorityAttach(snapshot = semanticSnapshot(1)): AuthorityAttachResponse {
  const cursor = {
    ...snapshot.owner,
    transportSequence: 1,
    snapshotSequence: snapshot.snapshotSequence,
  };
  return {
    baseline: {
      sessionId: SESSION_A,
      rendererGeneration: 0,
      owner: snapshot.owner,
      semantic: { sync: { state: "following", cursor }, snapshot },
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
      publicationHighWatermark: 0,
    },
    replay: [],
  };
}

function semanticPublication(
  transportSequence: number,
  snapshot: SemanticSnapshot,
  records: AuthorityRecord[] = [],
  sessionId: SessionId = SESSION_A,
): RendererPublication {
  return {
    sessionId,
    rendererGeneration: 0,
    publicationSequence: transportSequence - 1,
    plane: "semantic",
    owner: snapshot.owner,
    payload: {
      owner: snapshot.owner,
      transportSequence,
      frameId: `frame-${transportSequence}`,
      records,
      terminalSnapshot: snapshot,
    },
  } as RendererPublication;
}

describe("sessions store - authority intent projection", () => {
  beforeEach(() => {
    useSessionsStore.setState({
      sessions: new Map(),
      activeSessionId: null,
      workspaces: new Map(),
      activeWorkspacePath: null,
    });
    useSessionsStore.getState().createSession(SESSION_A, WORKSPACE);
    useSessionsStore.getState().applyRuntimeState(SESSION_A, runtimeState(false));
  });

  afterEach(() => vi.unstubAllGlobals());

  it("does not mutate canonical model state when an intent receipt arrives before its frame", async () => {
    useSessionsStore.getState().applyAuthorityAttach(SESSION_A, authorityAttach());
    vi.stubGlobal("window", {
      pivis: {
        invoke: vi.fn(async () => ({
          status: "admitted",
          intentId: "intent-1",
          owner: { hostInstanceId: "host-1", sessionEpoch: 1 },
        })),
      },
    });

    const result = await useSessionsStore.getState().applyModelChange(SESSION_A, {
      id: "model-new",
      provider: "provider",
    });

    expect(result.ok).toBe(true);
    expect(useSessionsStore.getState().sessions.get(SESSION_A)?.currentModel).toBe("model-old");
  });

  it("ignores a stale authority outcome after a newer frame", () => {
    useSessionsStore.getState().applyAuthorityAttach(SESSION_A, authorityAttach());
    const fresh = semanticSnapshot(2, { model: { id: "model-new", provider: "provider" } });
    useSessionsStore.getState().applyAuthorityPublication(semanticPublication(2, fresh));
    const stale = semanticSnapshot(1, { model: { id: "model-stale", provider: "provider" } });
    useSessionsStore.getState().applyAuthorityPublication(
      semanticPublication(1, stale, [
        {
          type: "intent_outcome",
          outcome: {
            intentId: "old-rename",
            owner: stale.owner,
            kind: "rename",
            state: "completed",
            result: { name: "stale name" },
          },
        },
      ]),
    );

    const session = useSessionsStore.getState().sessions.get(SESSION_A);
    expect(session?.currentModel).toBe("model-new");
    expect(session?.sessionName).not.toBe("stale name");
  });

  it("does not let transcript metadata override authoritative snapshots", () => {
    const snapshot = semanticSnapshot(1, { thinkingLevel: "high" });
    useSessionsStore.getState().applyAuthorityAttach(SESSION_A, authorityAttach(snapshot));
    useSessionsStore.getState().applyEvents(SESSION_A, [
      { type: "thinking_level_changed", level: "off" },
      { type: "session_info_changed", name: "transcript name" },
    ]);

    const session = useSessionsStore.getState().sessions.get(SESSION_A);
    expect(session?.thinkingLevel).toBe("high");
    expect(session?.sessionName).toBeUndefined();
  });

  it("never falls back to a legacy snapshot after semantic synchronization is fenced", () => {
    useSessionsStore.getState().applyAuthorityAttach(SESSION_A, authorityAttach());
    useSessionsStore.getState().applyRuntimeState(SESSION_A, runtimeState(true, 99));
    useSessionsStore
      .getState()
      .applyAuthorityPublication(semanticPublication(3, semanticSnapshot(3)));

    const session = useSessionsStore.getState().sessions.get(SESSION_A);
    expect(session?.authorityProjection?.semantic.state).toBe("synchronizing");
    expect(session?.authorityProjection?.authoritativeSnapshot).toBeUndefined();
    expect(session?.authorityProjection?.staleDiagnosticSnapshot?.model?.id).toBe("model-old");
    expect(isSessionWorking(session)).toBe(false);
    expect(session?.currentModel).toBeUndefined();
  });

  it("keeps an unavailable semantic snapshot diagnostic-only", () => {
    useSessionsStore.getState().applyAuthorityAttach(SESSION_A, authorityAttach());
    useSessionsStore.getState().markAuthorityUnavailable(SESSION_A, "transport_lost");

    const session = useSessionsStore.getState().sessions.get(SESSION_A);
    expect(session?.authorityProjection?.semantic.state).toBe("unavailable");
    expect(session?.authorityProjection?.authoritativeSnapshot).toBeUndefined();
    expect(session?.authorityProjection?.staleDiagnosticSnapshot?.model?.id).toBe("model-old");
    expect(session?.currentModel).toBeUndefined();
    expect(session?.statusSegments.size).toBe(0);
  });

  it("commits semantic fields atomically without leaking extension-plane catalog values", () => {
    useSessionsStore.getState().applyAuthorityAttach(SESSION_A, authorityAttach());
    const next = semanticSnapshot(2, {
      sdk: {
        isStreaming: true,
        isIdle: false,
        isCompacting: true,
        isRetrying: true,
        retryAttempt: 2,
        isBashRunning: true,
      },
      model: { id: "model-new", provider: "new-provider" },
      thinkingLevel: "high",
      editor: { revision: 7, text: "authoritative edit", attachments: ["attachment"] },
      queues: {
        steering: ["steer"],
        followUp: ["follow"],
        steeringIntentIds: ["steer-intent"],
        followUpIntentIds: ["follow-intent"],
      },
      catalog: {
        notifications: [],
        statuses: { mode: "busy" },
        widgets: { widget: ["line"] },
        title: "Authority title",
        capabilityDiagnostics: [],
      },
    });
    useSessionsStore.getState().applyAuthorityPublication(semanticPublication(2, next));

    const session = useSessionsStore.getState().sessions.get(SESSION_A);
    expect(session).toMatchObject({
      hostInstanceId: "host-1",
      sessionEpoch: 1,
      currentModel: "model-new",
      currentProvider: "new-provider",
      thinkingLevel: "high",
      editorRevision: 7,
      editorAttachments: ["attachment"],
      sessionTitle: "Authority title",
    });
    expect(session?.queuedMessages?.steering[0]?.text).toBe("steer");
    expect(session?.statusSegments.get("mode")).toBeUndefined();
    expect(session?.widgets.get("widget")).toBeUndefined();
    expect(isSessionWorking(session)).toBe(true);
  });

  it("replaces an owner without retaining predecessor semantic fields", () => {
    useSessionsStore.getState().applyAuthorityAttach(SESSION_A, authorityAttach());
    useSessionsStore.getState().applyAuthorityPublication(
      semanticPublication(2, semanticSnapshot(2), [
        {
          type: "intent_outcome",
          outcome: {
            intentId: "rename-old",
            owner: { hostInstanceId: "host-1", sessionEpoch: 1 },
            kind: "rename",
            state: "completed",
            result: { name: "predecessor" },
          },
        },
      ]),
    );
    const successor = semanticSnapshot(1, {
      owner: { hostInstanceId: "host-2", sessionEpoch: 2 },
      model: { id: "successor-model" },
      thinkingLevel: "off",
      catalog: { notifications: [], statuses: {}, widgets: {}, capabilityDiagnostics: [] },
    });
    const successorAttach = authorityAttach(successor);
    successorAttach.baseline.publicationHighWatermark = 2;
    useSessionsStore.getState().applyAuthorityAttach(SESSION_A, successorAttach);

    const session = useSessionsStore.getState().sessions.get(SESSION_A);
    expect(session?.hostInstanceId).toBe("host-2");
    expect(session?.currentModel).toBe("successor-model");
    expect(session?.sessionName).toBeUndefined();
    expect(session?.queuedMessages).toBeUndefined();
  });
});

describe("sessions store - explicit search result open", () => {
  const invokeMock = vi.fn();

  beforeEach(() => {
    useSessionsStore.setState({
      sessions: new Map(),
      activeSessionId: null,
      workspaces: new Map(),
      activeWorkspacePath: null,
      newSessionDrafts: new Map(),
      sessionDrafts: new Map(),
    });
    invokeMock.mockReset();
    invokeMock.mockImplementation(async (channel: string, payload: unknown) => {
      if (channel === "session.loadHistory") {
        return loadedHistory(payload, []);
      }
      if (channel === "session.activate") return undefined;
      throw new Error(`unexpected channel ${channel}`);
    });
    vi.stubGlobal("window", { pivis: { invoke: invokeMock } });
  });

  it("adopts the validated main result and preserves normal activation-visit ownership", async () => {
    const file = "/tmp/search-result.jsonl";
    const preopened: SessionSearchOpenResult = {
      outcome: "opened",
      sessionId: SESSION_A,
      sessionFile: file,
      workspacePath: WORKSPACE,
      name: "Search result",
      preview: "saved preview",
      sessionStatus: "cold",
    };

    await expect(
      useSessionsStore.getState().openSessionTab(WORKSPACE, file, {
        focus: true,
        preopened,
      }),
    ).resolves.toBe(SESSION_A);

    expect(invokeMock).not.toHaveBeenCalledWith("session.open", expect.anything());
    const visitId = useSessionsStore.getState().sessions.get(SESSION_A)?.activationVisitId;
    expect(visitId).toEqual(expect.any(String));
    expect(invokeMock).toHaveBeenCalledWith("session.activate", {
      sessionId: SESSION_A,
      activationVisitId: visitId,
    });
  });

  it("restores the previous active session without releasing its visit when activation fails", async () => {
    const previousFile = "/tmp/previous.jsonl";
    const targetFile = "/tmp/search-fails.jsonl";
    useSessionsStore
      .getState()
      .createSession(SESSION_A, WORKSPACE, previousFile, "Previous", undefined, "ready");
    useSessionsStore.setState((state) => {
      const sessions = new Map(state.sessions);
      const previous = sessions.get(SESSION_A);
      if (previous) sessions.set(SESSION_A, { ...previous, activationVisitId: "previous-visit" });
      return { sessions, activeSessionId: SESSION_A, activeWorkspacePath: WORKSPACE };
    });
    invokeMock.mockImplementation(async (channel: string, payload: unknown) => {
      if (channel === "session.loadHistory") {
        return loadedHistory(payload, []);
      }
      if (channel === "session.activate") throw new Error("host startup failed");
      throw new Error(`unexpected channel ${channel}`);
    });
    const preopened: SessionSearchOpenResult = {
      outcome: "opened",
      sessionId: SESSION_B,
      sessionFile: targetFile,
      workspacePath: WORKSPACE,
      name: "Broken target",
      preview: null,
      sessionStatus: "cold",
    };

    await expect(
      useSessionsStore.getState().openSessionTab(WORKSPACE, targetFile, {
        focus: true,
        preopened,
      }),
    ).resolves.toBeNull();

    const state = useSessionsStore.getState();
    expect(state.activeSessionId).toBe(SESSION_A);
    expect(state.activeWorkspacePath).toBe(WORKSPACE);
    expect(state.sessions.get(SESSION_A)?.activationVisitId).toBe("previous-visit");
    expect(invokeMock).not.toHaveBeenCalledWith(
      "session.releaseActivationVisit",
      expect.anything(),
    );
  });

  it("reconciles a stale failed renderer record before adopting a replacement", async () => {
    const file = "/tmp/search-result.jsonl";
    useSessionsStore
      .getState()
      .createSession(SESSION_B, WORKSPACE, file, "Failed predecessor", undefined, "failed");
    useSessionsStore.setState({ activeSessionId: SESSION_B });
    const preopened: SessionSearchOpenResult = {
      outcome: "opened",
      sessionId: SESSION_A,
      sessionFile: file,
      workspacePath: WORKSPACE,
      name: "Replacement",
      preview: "saved preview",
      sessionStatus: "cold",
    };

    await expect(
      useSessionsStore.getState().openSessionTab(WORKSPACE, file, {
        focus: true,
        preopened,
      }),
    ).resolves.toBe(SESSION_A);

    const state = useSessionsStore.getState();
    expect(state.sessions.has(SESSION_B)).toBe(false);
    expect(state.sessions.get(SESSION_A)?.sessionFile).toBe(file);
    expect(state.activeSessionId).toBe(SESSION_A);
    expect(invokeMock).toHaveBeenCalledWith(
      "session.activate",
      expect.objectContaining({ sessionId: SESSION_A, activationVisitId: expect.any(String) }),
    );
    expect(invokeMock).not.toHaveBeenCalledWith(
      "session.activate",
      expect.objectContaining({ sessionId: SESSION_B }),
    );
  });
});
