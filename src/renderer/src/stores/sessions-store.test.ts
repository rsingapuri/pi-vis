import type { SessionId } from "@shared/ids.js";
import { ExtensionUiRequestSchema } from "@shared/pi-protocol/extension-ui.js";
import type { ModelInfo } from "@shared/pi-protocol/responses.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { shouldShowWorkingIndicator, useSessionsStore } from "./sessions-store.js";
import { useSettingsStore } from "./settings-store.js";

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
    expect(panel()).toEqual({ id: 1, overlay: true, buffer: [] });
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

  it("panel_clear_all clears the panel unconditionally", () => {
    const s = useSessionsStore.getState();
    s.handlePanelEvent(SESSION_A, { type: "panel_open", panelId: 1, overlay: false });
    s.handlePanelEvent(SESSION_A, { type: "panel_clear_all" });
    expect(panel()).toBeUndefined();
  });

  it("host_fallback surfaces a warning toast with the reason", () => {
    useSessionsStore.getState().handlePanelEvent(SESSION_A, {
      type: "host_fallback",
      reason: "pi too old — update pi for panel support",
    });
    const toasts = useSessionsStore.getState().sessions.get(SESSION_A)?.toasts ?? [];
    expect(toasts.at(-1)).toMatchObject({
      type: "warning",
      message: "pi too old — update pi for panel support",
    });
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
// An extension slash-command (e.g. /agents) runs via session.prompt, so pi
// reports the turn "active" (isStreaming) while its handler is blocked on a
// select dialog or custom panel. The indicator must NOT show during that wait.
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

  it("is false when not streaming", () => {
    expect(shouldShowWorkingIndicator(session())).toBe(false);
  });

  it("is true when streaming with no extension UI open", () => {
    useSessionsStore.getState().setStreaming(SESSION_A, true);
    expect(shouldShowWorkingIndicator(session())).toBe(true);
  });

  it("is false when streaming but a dialog is pending (e.g. /agents select)", () => {
    useSessionsStore.getState().setStreaming(SESSION_A, true);
    useSessionsStore.getState().addUiRequest(SESSION_A, {
      type: "extension_ui_request",
      id: "d1",
      method: "select",
      title: "Agents",
      options: ["Settings"],
    });
    expect(shouldShowWorkingIndicator(session())).toBe(false);
  });

  it("is false when streaming but a custom panel is open (e.g. Settings)", () => {
    useSessionsStore.getState().setStreaming(SESSION_A, true);
    useSessionsStore
      .getState()
      .handlePanelEvent(SESSION_A, { type: "panel_open", panelId: 1, overlay: false });
    expect(shouldShowWorkingIndicator(session())).toBe(false); // panel open → suppressed
  });

  it("returns to true once the extension UI closes (panel_close) while still streaming", () => {
    const store = useSessionsStore.getState();
    store.setStreaming(SESSION_A, true);
    store.handlePanelEvent(SESSION_A, { type: "panel_open", panelId: 1, overlay: false });
    expect(shouldShowWorkingIndicator(session())).toBe(false);
    store.handlePanelEvent(SESSION_A, { type: "panel_close", panelId: 1 });
    expect(shouldShowWorkingIndicator(session())).toBe(true);
  });

  it("is false for an unknown/undefined session", () => {
    expect(shouldShowWorkingIndicator(undefined)).toBe(false);
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
describe("sessions store - bootstrapModelState (model/thinking invariants)", () => {
  let setModelCalls: Array<{ sessionId: string; modelId: string }>;
  let setThinkingCalls: Array<{ sessionId: string; level: string }>;
  // Per-session pi-side current model so get_state / get_available_models
  // reflect earlier set_model calls (mirrors real pi switching the model).
  let piModel: Map<string, string>;

  type Cmd = { type: string; modelId?: string; level?: string };
  type Payload = { sessionId: string; command: Cmd };

  function makeInvoke() {
    return vi.fn(async (_channel: string, payload: Payload) => {
      const { sessionId, command } = payload;
      switch (command.type) {
        case "get_available_models":
          return {
            success: true,
            data: {
              models: [
                { id: "openrouter/model-x", provider: "openrouter" },
                { id: "openrouter/model-y", provider: "openrouter" },
              ],
              currentModelId: piModel.get(sessionId) ?? "openrouter/model-x",
            },
          };
        case "set_model":
          piModel.set(sessionId, command.modelId as string);
          setModelCalls.push({ sessionId, modelId: command.modelId as string });
          return { success: true };
        case "get_state":
          return {
            success: true,
            data: {
              model: { id: piModel.get(sessionId) ?? "openrouter/model-x" },
              thinkingLevel: "off",
              sessionId,
            },
          };
        case "set_thinking_level":
          setThinkingCalls.push({ sessionId, level: command.level as string });
          return { success: true };
        default:
          return { success: true, data: {} };
      }
    });
  }

  beforeEach(() => {
    setModelCalls = [];
    setThinkingCalls = [];
    piModel = new Map();
    vi.stubGlobal("window", { pivis: { invoke: makeInvoke() } });
    useSettingsStore.setState({
      settings: {
        ...useSettingsStore.getState().settings,
        lastUsedModel: null,
        lastUsedThinkingLevel: null,
      },
    });
    useSessionsStore.setState({
      sessions: new Map(),
      activeSessionId: null,
      workspaces: new Map(),
      activeWorkspacePath: null,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const setLastUsedModel = (modelId: string) =>
    useSettingsStore.setState({
      settings: {
        ...useSettingsStore.getState().settings,
        lastUsedModel: { provider: "openrouter", modelId },
      },
    });

  it("a brand-new session starts un-initialized", () => {
    useSessionsStore.getState().createSession(SESSION_A, WORKSPACE);
    expect(useSessionsStore.getState().sessions.get(SESSION_A)?.modelInitialized).toBe(false);
  });

  it("applies the global last-used model preference once for a new session", async () => {
    setLastUsedModel("openrouter/model-y");
    useSessionsStore.getState().createSession(SESSION_A, WORKSPACE);
    await useSessionsStore.getState().bootstrapModelState(SESSION_A);

    expect(setModelCalls).toEqual([{ sessionId: SESSION_A, modelId: "openrouter/model-y" }]);
    expect(useSessionsStore.getState().sessions.get(SESSION_A)?.currentModel).toBe(
      "openrouter/model-y",
    );
    expect(useSessionsStore.getState().sessions.get(SESSION_A)?.modelInitialized).toBe(true);
  });

  it("is a no-op on re-invocation — a remount cannot re-apply the preference", async () => {
    setLastUsedModel("openrouter/model-y");
    useSessionsStore.getState().createSession(SESSION_A, WORKSPACE);
    await useSessionsStore.getState().bootstrapModelState(SESSION_A);
    const callsAfterFirst = setModelCalls.length;

    // Simulate the SessionHeader remounting (every tab switch) firing it again.
    await useSessionsStore.getState().bootstrapModelState(SESSION_A);

    expect(setModelCalls.length).toBe(callsAfterFirst);
    expect(useSessionsStore.getState().sessions.get(SESSION_A)?.currentModel).toBe(
      "openrouter/model-y",
    );
  });

  it("switching away, changing the global preference, and returning does NOT change the first session's model", async () => {
    // Session A is created and bootstrapped while no preference is set, so it
    // keeps pi's default (model-x).
    useSessionsStore.getState().createSession(SESSION_A, WORKSPACE);
    await useSessionsStore.getState().bootstrapModelState(SESSION_A);
    expect(useSessionsStore.getState().sessions.get(SESSION_A)?.currentModel).toBe(
      "openrouter/model-x",
    );
    expect(setModelCalls).toEqual([]);

    // The user opens session B and picks model-y there — which writes the
    // GLOBAL last-used preference.
    useSessionsStore.getState().createSession(SESSION_B, WORKSPACE);
    setLastUsedModel("openrouter/model-y");
    await useSessionsStore.getState().bootstrapModelState(SESSION_B);
    expect(useSessionsStore.getState().sessions.get(SESSION_B)?.currentModel).toBe(
      "openrouter/model-y",
    );

    // Switching back to A remounts A's header → re-invokes bootstrap. A must
    // be untouched: no set_model to A, and its model is still model-x.
    await useSessionsStore.getState().bootstrapModelState(SESSION_A);
    expect(setModelCalls.some((c) => c.sessionId === SESSION_A)).toBe(false);
    expect(useSessionsStore.getState().sessions.get(SESSION_A)?.currentModel).toBe(
      "openrouter/model-x",
    );
  });

  it("never applies the global preference to a resumed session", async () => {
    setLastUsedModel("openrouter/model-y");
    // Resumed session: created WITH a file → resumed=true.
    useSessionsStore.getState().createSession(SESSION_A, WORKSPACE, "/f/a.jsonl");
    await useSessionsStore.getState().bootstrapModelState(SESSION_A);

    expect(setModelCalls).toEqual([]);
    expect(useSessionsStore.getState().sessions.get(SESSION_A)?.currentModel).toBe(
      "openrouter/model-x",
    );
  });

  it("applies the global last-used thinking level once for a new session", async () => {
    useSettingsStore.setState({
      settings: {
        ...useSettingsStore.getState().settings,
        lastUsedThinkingLevel: "high",
      },
    });
    useSessionsStore.getState().createSession(SESSION_A, WORKSPACE);
    await useSessionsStore.getState().bootstrapModelState(SESSION_A);

    expect(setThinkingCalls).toEqual([{ sessionId: SESSION_A, level: "high" }]);
    expect(useSessionsStore.getState().sessions.get(SESSION_A)?.thinkingLevel).toBe("high");

    // Remount: no second set_thinking_level.
    await useSessionsStore.getState().bootstrapModelState(SESSION_A);
    expect(setThinkingCalls).toEqual([{ sessionId: SESSION_A, level: "high" }]);
  });

  it("seeds thinking level from pi (no preference) without sending set_thinking_level", async () => {
    useSessionsStore.getState().createSession(SESSION_A, WORKSPACE);
    await useSessionsStore.getState().bootstrapModelState(SESSION_A);
    expect(setThinkingCalls).toEqual([]);
    expect(useSessionsStore.getState().sessions.get(SESSION_A)?.thinkingLevel).toBe("off");
  });
});

/**
 * `applyModelChange` / `applyThinkingLevel` are the single mutation paths for
 * the model / thinking dropdowns. They update the store optimistically (so the
 * dropdown shows the requested value immediately — invariant #1's "queued
 * change about to be sent") but MUST revert to the prior value if pi rejects
 * the change, so the dropdown never lingers on something not actually in
 * effect. The global last-used preference is persisted only on success.
 */
describe("sessions store - applyModelChange / applyThinkingLevel (revert on failure)", () => {
  let updateSpy: ReturnType<typeof vi.fn>;

  type Cmd = { type: string };
  type Payload = { sessionId: string; command: Cmd };

  function stubInvoke(impl: (channel: string, payload: Payload) => Promise<unknown>) {
    vi.stubGlobal("window", { pivis: { invoke: vi.fn(impl) } });
  }

  const MODEL_Y = { id: "openrouter/model-y", provider: "openrouter" } as ModelInfo;

  beforeEach(() => {
    // Override settings-store's `update` with a spy so we can assert exactly
    // when the global last-used preference is (and isn't) persisted.
    updateSpy = vi.fn(async () => {});
    useSettingsStore.setState({ update: updateSpy as unknown as () => Promise<void> });
    useSessionsStore.setState({
      sessions: new Map(),
      activeSessionId: null,
      workspaces: new Map(),
      activeWorkspacePath: null,
    });
    useSessionsStore.getState().createSession(SESSION_A, WORKSPACE);
    useSessionsStore.getState().setCurrentModel(SESSION_A, "openrouter/model-x");
    useSessionsStore.getState().setThinkingLevel(SESSION_A, "low");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("applyModelChange commits the model and persists last-used on success", async () => {
    stubInvoke(async () => ({ success: true, data: {} }));
    const res = await useSessionsStore.getState().applyModelChange(SESSION_A, MODEL_Y);
    expect(res.ok).toBe(true);
    expect(useSessionsStore.getState().sessions.get(SESSION_A)?.currentModel).toBe(
      "openrouter/model-y",
    );
    expect(updateSpy).toHaveBeenCalledWith({
      lastUsedModel: { provider: "openrouter", modelId: "openrouter/model-y" },
    });
  });

  it("applyModelChange reverts to the prior model when pi returns success:false", async () => {
    stubInvoke(async (_c, p) =>
      p.command.type === "set_model"
        ? { success: false, error: "nope" }
        : { success: true, data: {} },
    );
    const res = await useSessionsStore.getState().applyModelChange(SESSION_A, MODEL_Y);
    expect(res.ok).toBe(false);
    expect(res.error).toContain("nope");
    expect(useSessionsStore.getState().sessions.get(SESSION_A)?.currentModel).toBe(
      "openrouter/model-x",
    );
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it("applyModelChange reverts when the IPC throws", async () => {
    stubInvoke(async (_c, p) => {
      if (p.command.type === "set_model") throw new Error("boom");
      return { success: true, data: {} };
    });
    const res = await useSessionsStore.getState().applyModelChange(SESSION_A, MODEL_Y);
    expect(res.ok).toBe(false);
    expect(useSessionsStore.getState().sessions.get(SESSION_A)?.currentModel).toBe(
      "openrouter/model-x",
    );
  });

  it("applyModelChange does NOT clobber a newer model that landed during a failed switch", async () => {
    stubInvoke(async (_c, p) => {
      if (p.command.type === "set_model") {
        // A concurrent change lands while set_model is in flight.
        useSessionsStore.getState().setCurrentModel(SESSION_A, "openrouter/model-z");
        throw new Error("boom");
      }
      return { success: true, data: {} };
    });
    await useSessionsStore.getState().applyModelChange(SESSION_A, MODEL_Y);
    // Revert is skipped because our optimistic value was already superseded.
    expect(useSessionsStore.getState().sessions.get(SESSION_A)?.currentModel).toBe(
      "openrouter/model-z",
    );
  });

  it("applyThinkingLevel commits and reports the clamped level pi applied", async () => {
    stubInvoke(async (_c, p) => {
      if (p.command.type === "get_state") return { success: true, data: { thinkingLevel: "off" } };
      return { success: true, data: {} };
    });
    const res = await useSessionsStore.getState().applyThinkingLevel(SESSION_A, "high");
    expect(res.ok).toBe(true);
    expect(res.clampedTo).toBe("off");
    expect(useSessionsStore.getState().sessions.get(SESSION_A)?.thinkingLevel).toBe("off");
    expect(updateSpy).toHaveBeenCalledWith({ lastUsedThinkingLevel: "high" });
  });

  it("applyThinkingLevel reverts to the prior level on failure and does not persist", async () => {
    stubInvoke(async (_c, p) =>
      p.command.type === "set_thinking_level"
        ? { success: false, error: "no" }
        : { success: true, data: {} },
    );
    const res = await useSessionsStore.getState().applyThinkingLevel(SESSION_A, "high");
    expect(res.ok).toBe(false);
    expect(useSessionsStore.getState().sessions.get(SESSION_A)?.thinkingLevel).toBe("low");
    expect(updateSpy).not.toHaveBeenCalled();
  });
});
