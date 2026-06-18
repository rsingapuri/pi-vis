import type { SessionId } from "@shared/ids.js";
import { ExtensionUiRequestSchema } from "@shared/pi-protocol/extension-ui.js";
import { beforeEach, describe, expect, it } from "vitest";
import { useSessionsStore } from "./sessions-store.js";

const SESSION_A = "session-a" as SessionId;
const SESSION_B = "session-b" as SessionId;
const SESSION_C = "session-c" as SessionId;
const WORKSPACE = "/tmp/test-workspace";

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

  it("setThinkingLevel updates the session's level (used to seed from get_state)", () => {
    useSessionsStore.getState().setThinkingLevel(SESSION_A, "high");
    expect(useSessionsStore.getState().sessions.get(SESSION_A)?.thinkingLevel).toBe("high");
  });

  it("applyEvent reconciles to the value pi reports in thinking_level_changed", () => {
    // User requested "xhigh"; pi silently clamped to "high".
    useSessionsStore.getState().setThinkingLevel(SESSION_A, "xhigh");
    expect(useSessionsStore.getState().sessions.get(SESSION_A)?.thinkingLevel).toBe("xhigh");

    useSessionsStore.getState().applyEvent(SESSION_A, {
      type: "thinking_level_changed",
      level: "high",
    });

    // The dropdown must show what pi actually applied, not the requested value.
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

  it("scopes thinking-level changes to a single session", () => {
    useSessionsStore.getState().setThinkingLevel(SESSION_A, "high");
    useSessionsStore.getState().setThinkingLevel(SESSION_B, "off");
    expect(useSessionsStore.getState().sessions.get(SESSION_A)?.thinkingLevel).toBe("high");
    expect(useSessionsStore.getState().sessions.get(SESSION_B)?.thinkingLevel).toBe("off");
  });

  it("tolerates coerced-off values (e.g. switching to a non-reasoning model)", () => {
    useSessionsStore.getState().setThinkingLevel(SESSION_A, "xhigh");
    useSessionsStore.getState().applyEvent(SESSION_A, {
      type: "thinking_level_changed",
      level: "off",
    });
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

  it("updates sessionName when pi emits session_info_changed", () => {
    useSessionsStore.getState().applyEvent(SESSION_A, {
      type: "session_info_changed",
      name: "Refactor config loader",
    });
    expect(useSessionsStore.getState().sessions.get(SESSION_A)?.sessionName).toBe(
      "Refactor config loader",
    );
  });

  it("overwrites a previously-set name with the new one from pi", () => {
    useSessionsStore.getState().setSessionName(SESSION_A, "Old name");
    useSessionsStore.getState().applyEvent(SESSION_A, {
      type: "session_info_changed",
      name: "New name",
    });
    expect(useSessionsStore.getState().sessions.get(SESSION_A)?.sessionName).toBe("New name");
  });

  it("scopes session name changes to a single session", () => {
    useSessionsStore.getState().createSession(SESSION_B, WORKSPACE);
    useSessionsStore.getState().applyEvent(SESSION_A, {
      type: "session_info_changed",
      name: "A's name",
    });
    useSessionsStore.getState().applyEvent(SESSION_B, {
      type: "session_info_changed",
      name: "B's name",
    });
    expect(useSessionsStore.getState().sessions.get(SESSION_A)?.sessionName).toBe("A's name");
    expect(useSessionsStore.getState().sessions.get(SESSION_B)?.sessionName).toBe("B's name");
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

  it("addUserMessage does NOT overwrite a sessionName set by pi or the user", () => {
    useSessionsStore.getState().createSession(SESSION_A, WORKSPACE, "/f/a.jsonl");
    useSessionsStore.getState().setSessionName(SESSION_A, "Renamed by user");
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

  it("setStatus → setStatus(undef) round-trip removes the key from statusSegments", () => {
    useSessionsStore.getState().addUiRequest(SESSION_A, {
      type: "extension_ui_request",
      id: "s1",
      method: "setStatus",
      statusKey: "plan",
      statusText: "plan active",
    });
    expect(useSessionsStore.getState().sessions.get(SESSION_A)?.statusSegments.get("plan")).toBe(
      "plan active",
    );

    useSessionsStore.getState().addUiRequest(SESSION_A, {
      type: "extension_ui_request",
      id: "s2",
      method: "setStatus",
      statusKey: "plan",
      // statusText intentionally omitted: this is how a clear arrives on
      // the wire. The store must treat absent ⇒ delete, not set-undefined.
    });
    expect(useSessionsStore.getState().sessions.get(SESSION_A)?.statusSegments.has("plan")).toBe(
      false,
    );
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

  it("setWidget → setWidget(undef) round-trip removes the key from widgets", () => {
    useSessionsStore.getState().addUiRequest(SESSION_A, {
      type: "extension_ui_request",
      id: "w1",
      method: "setWidget",
      widgetKey: "plan",
      widgetLines: ["Plan mode: planning", "Produce a <proposed_plan> block."],
    });
    expect(useSessionsStore.getState().sessions.get(SESSION_A)?.widgets.get("plan")).toEqual([
      "Plan mode: planning",
      "Produce a <proposed_plan> block.",
    ]);

    useSessionsStore.getState().addUiRequest(SESSION_A, {
      type: "extension_ui_request",
      id: "w2",
      method: "setWidget",
      widgetKey: "plan",
      // widgetLines intentionally omitted: clear-on-undefined contract.
    });
    expect(useSessionsStore.getState().sessions.get(SESSION_A)?.widgets.has("plan")).toBe(false);
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
describe("sessions store - unread turn-result status dot", () => {
  beforeEach(() => {
    useSessionsStore.setState({
      sessions: new Map(),
      activeSessionId: null,
      workspaces: new Map(),
      activeWorkspacePath: null,
    });
    useSessionsStore.getState().createSession(SESSION_A, WORKSPACE);
    useSessionsStore.getState().createSession(SESSION_B, WORKSPACE);
  });

  const finishTurn = (sessionId: SessionId, opts: { error?: boolean } = {}) => {
    const store = useSessionsStore.getState();
    store.applyEvent(sessionId, { type: "agent_start" });
    store.applyEvent(sessionId, {
      type: "message_end",
      message: opts.error
        ? { role: "assistant", stopReason: "error", errorMessage: "provider down" }
        : { role: "assistant", stopReason: "end_turn" },
    });
    store.applyEvent(sessionId, { type: "agent_end" });
  };

  it("marks a finished turn 'done' and an erroring turn 'error'", () => {
    finishTurn(SESSION_A);
    expect(useSessionsStore.getState().sessions.get(SESSION_A)?.unreadStatus).toBe("done");

    finishTurn(SESSION_A, { error: true });
    expect(useSessionsStore.getState().sessions.get(SESSION_A)?.unreadStatus).toBe("error");
  });

  it("starts a new turn with no unread marker", () => {
    expect(useSessionsStore.getState().sessions.get(SESSION_A)?.unreadStatus).toBeUndefined();
  });

  it("a background session's marker persists while the user is elsewhere", () => {
    useSessionsStore.getState().setActiveSession(SESSION_B); // user is in B
    finishTurn(SESSION_A); // A finishes in the background
    // User never visits A — the notification must remain.
    expect(useSessionsStore.getState().sessions.get(SESSION_A)?.unreadStatus).toBe("done");
  });

  it("clicking into the background session keeps the marker (not yet 'moved on')", () => {
    useSessionsStore.getState().setActiveSession(SESSION_B);
    finishTurn(SESSION_A);
    useSessionsStore.getState().setActiveSession(SESSION_A); // user visits A
    // Just visiting is not enough — they must leave or send a message.
    expect(useSessionsStore.getState().sessions.get(SESSION_A)?.unreadStatus).toBe("done");
  });

  it("clears when the user leaves the session they were viewing", () => {
    useSessionsStore.getState().setActiveSession(SESSION_A);
    finishTurn(SESSION_A); // seen while active
    useSessionsStore.getState().setActiveSession(SESSION_B); // move on
    expect(useSessionsStore.getState().sessions.get(SESSION_A)?.unreadStatus).toBeUndefined();
  });

  it("clears when the user clicks into the background session then leaves", () => {
    useSessionsStore.getState().setActiveSession(SESSION_B);
    finishTurn(SESSION_A); // unread notification in A
    useSessionsStore.getState().setActiveSession(SESSION_A); // visit A
    expect(useSessionsStore.getState().sessions.get(SESSION_A)?.unreadStatus).toBe("done");
    useSessionsStore.getState().setActiveSession(SESSION_B); // leave A
    expect(useSessionsStore.getState().sessions.get(SESSION_A)?.unreadStatus).toBeUndefined();
  });

  it("starting a new turn in the session clears the marker", () => {
    useSessionsStore.getState().setActiveSession(SESSION_B);
    finishTurn(SESSION_A); // unread in background A
    useSessionsStore.getState().setActiveSession(SESSION_A);
    // User sends a new message → agent_start acknowledges the old marker.
    useSessionsStore.getState().applyEvent(SESSION_A, { type: "agent_start" });
    expect(useSessionsStore.getState().sessions.get(SESSION_A)?.unreadStatus).toBeUndefined();
  });

  it("switching between other sessions does not touch an unvisited background session", () => {
    useSessionsStore.getState().createSession(SESSION_C, WORKSPACE);
    useSessionsStore.getState().setActiveSession(SESSION_B); // user in B
    finishTurn(SESSION_A); // A finishes in the background (never visited)
    useSessionsStore.getState().setActiveSession(SESSION_C); // user switches B → C
    // A was never visited; its notification must persist.
    expect(useSessionsStore.getState().sessions.get(SESSION_A)?.unreadStatus).toBe("done");
  });

  it("clears the left (seen) session but keeps the destination's background marker", () => {
    useSessionsStore.getState().setActiveSession(SESSION_B);
    finishTurn(SESSION_A); // A unread (background notification)
    finishTurn(SESSION_B); // B unread (active, user saw it)
    // Move B → A: B was seen and is being left → cleared.
    //              A is the destination being visited → marker survives.
    useSessionsStore.getState().setActiveSession(SESSION_A);
    expect(useSessionsStore.getState().sessions.get(SESSION_B)?.unreadStatus).toBeUndefined();
    expect(useSessionsStore.getState().sessions.get(SESSION_A)?.unreadStatus).toBe("done");
  });

  // ── Auto-retry: a willRetry agent_end is not a real turn end ───────────────
  // pi reports a transient failure as an erroring message_end + an agent_end
  // with `willRetry: true`, then makes another attempt. We must not surface a
  // terminal dot (or stop "streaming") mid-retry, and the final color must
  // reflect only the last attempt — whether or not the retry re-emits
  // agent_start.

  const errorMsg = { role: "assistant" as const, stopReason: "error", errorMessage: "503" };
  const okMsg = { role: "assistant" as const, stopReason: "end_turn" };

  it("does not surface a dot on a willRetry agent_end (stays streaming)", () => {
    const store = useSessionsStore.getState();
    store.applyEvent(SESSION_A, { type: "agent_start" });
    store.applyEvent(SESSION_A, { type: "message_end", message: errorMsg });
    store.applyEvent(SESSION_A, { type: "agent_end", willRetry: true });
    const s = useSessionsStore.getState().sessions.get(SESSION_A);
    expect(s?.unreadStatus).toBeUndefined(); // no terminal marker yet
    expect(s?.isStreaming).toBe(true); // still working through the retry gap
  });

  it("a retry that succeeds ends 'done', not 'error' (no agent_start between attempts)", () => {
    const store = useSessionsStore.getState();
    store.applyEvent(SESSION_A, { type: "agent_start" });
    store.applyEvent(SESSION_A, { type: "message_end", message: errorMsg }); // attempt 1 fails
    store.applyEvent(SESSION_A, { type: "agent_end", willRetry: true });
    // Retry attempt arrives WITHOUT a fresh agent_start, just new messages.
    store.applyEvent(SESSION_A, { type: "message_end", message: okMsg }); // attempt 2 ok
    store.applyEvent(SESSION_A, { type: "agent_end" });
    const s = useSessionsStore.getState().sessions.get(SESSION_A);
    expect(s?.unreadStatus).toBe("done");
    expect(s?.isStreaming).toBe(false);
  });

  it("a retry that also fails ends 'error'", () => {
    const store = useSessionsStore.getState();
    store.applyEvent(SESSION_A, { type: "agent_start" });
    store.applyEvent(SESSION_A, { type: "message_end", message: errorMsg });
    store.applyEvent(SESSION_A, { type: "agent_end", willRetry: true });
    store.applyEvent(SESSION_A, { type: "message_end", message: errorMsg });
    store.applyEvent(SESSION_A, { type: "agent_end" });
    expect(useSessionsStore.getState().sessions.get(SESSION_A)?.unreadStatus).toBe("error");
  });
});
