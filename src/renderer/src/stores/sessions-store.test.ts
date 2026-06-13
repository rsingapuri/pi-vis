import type { SessionId } from "@shared/ids.js";
import { ExtensionUiRequestSchema } from "@shared/pi-protocol/extension-ui.js";
import { beforeEach, describe, expect, it } from "vitest";
import { computeOpenTabs, persistOpenTabs, useSessionsStore } from "./sessions-store.js";

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

  it("computeOpenTabs includes only sessions with a file, in insertion order, with active file from activeSessionId", () => {
    useSessionsStore.getState().addWorkspace(WORKSPACE);
    useSessionsStore.getState().createSession(SESSION_A, WORKSPACE, "/a.jsonl");
    useSessionsStore.getState().createSession(SESSION_B, WORKSPACE); // no file
    useSessionsStore.getState().createSession(SESSION_C, WORKSPACE, "/c.jsonl");
    useSessionsStore.getState().setActiveSession(SESSION_C);

    const { openTabs, activeSessionFile } = computeOpenTabs(
      useSessionsStore.getState().sessions,
      useSessionsStore.getState().activeSessionId,
    );
    expect(openTabs).toEqual([
      { workspacePath: WORKSPACE, sessionFile: "/a.jsonl" },
      { workspacePath: WORKSPACE, sessionFile: "/c.jsonl" },
    ]);
    expect(activeSessionFile).toBe("/c.jsonl");

    useSessionsStore.getState().setActiveSession(SESSION_B); // no file
    const result2 = computeOpenTabs(
      useSessionsStore.getState().sessions,
      useSessionsStore.getState().activeSessionId,
    );
    expect(result2.activeSessionFile).toBeNull();
    expect(result2.openTabs).toEqual([
      { workspacePath: WORKSPACE, sessionFile: "/a.jsonl" },
      { workspacePath: WORKSPACE, sessionFile: "/c.jsonl" },
    ]);
  });

  it("computeOpenTabs returns empty arrays for an empty map", () => {
    const { openTabs, activeSessionFile } = computeOpenTabs(new Map(), null);
    expect(openTabs).toEqual([]);
    expect(activeSessionFile).toBeNull();
  });

  it("persistOpenTabs under node does not throw", () => {
    useSessionsStore.getState().addWorkspace(WORKSPACE);
    useSessionsStore.getState().createSession(SESSION_A, WORKSPACE, "/a.jsonl");
    expect(() => persistOpenTabs()).not.toThrow();
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
