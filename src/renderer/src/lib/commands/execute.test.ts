import type { SessionId } from "@shared/ids.js";
import { describe, expect, it, vi } from "vitest";
import { type ExecuteDeps, type PickerRequest, executeAction } from "./execute.js";
import type { ComposerAction } from "./types.js";

const SID = "s1" as SessionId;

function makeDeps(overrides: Partial<ExecuteDeps> = {}): {
  deps: ExecuteDeps;
  calls: Record<string, unknown[]>;
} {
  const calls: Record<string, unknown[]> = {};
  // Capture every argument as an array — the executor's calls have
  // varying arity (addToast takes 2-3 args, invoke takes a payload,
  // openPicker takes 2 args, etc.). Storing `arguments` lets the test
  // assert against a faithful call signature.
  const make =
    (key: string) =>
    (...args: unknown[]) => {
      (calls[key] ??= []).push(args);
    };
  const deps: ExecuteDeps = {
    invoke: vi.fn(async (_ch: string, payload: unknown) => {
      (calls["invoke"] ??= []).push([payload]);
      return { success: true, data: {} };
    }) as ExecuteDeps["invoke"],
    submit: vi.fn(async () => ({
      intentId: "intent-1",
      hostInstanceId: "host-1",
      sessionEpoch: 1,
      editorRevision: 2,
      disposition: "consumed" as const,
    })) as NonNullable<ExecuteDeps["submit"]>,
    getSubmissionContext: () => ({
      hostInstanceId: "host-1",
      sessionEpoch: 1,
      editorRevision: 2,
      userMessageSequence: 0,
    }),
    addToast: make("addToast") as ExecuteDeps["addToast"],
    addUserMessage: make("addUserMessage") as ExecuteDeps["addUserMessage"],
    clearPendingUserEcho: make("clearPendingUserEcho") as ExecuteDeps["clearPendingUserEcho"],
    addBashCommand: make("addBashCommand") as ExecuteDeps["addBashCommand"],
    finishBashCommand: make("finishBashCommand") as ExecuteDeps["finishBashCommand"],
    applyModelChange: (async (...args: unknown[]) => {
      (calls["applyModelChange"] ??= []).push(args);
      return { ok: true };
    }) as ExecuteDeps["applyModelChange"],
    addCustomMessage: make("addCustomMessage") as ExecuteDeps["addCustomMessage"],
    openChangelog: make("openChangelog") as ExecuteDeps["openChangelog"],
    openPicker: make("openPicker") as ExecuteDeps["openPicker"],
    adoptSessionFile: (async (...args: unknown[]) => {
      (calls["adoptSessionFile"] ??= []).push(args);
    }) as ExecuteDeps["adoptSessionFile"],
    closeSessionTab: (async (...args: unknown[]) => {
      (calls["closeSessionTab"] ??= []).push(args);
    }) as ExecuteDeps["closeSessionTab"],
    openAppSettings: make("openAppSettings") as ExecuteDeps["openAppSettings"],
    openLogin: make("openLogin") as ExecuteDeps["openLogin"],
    openDiffViewer: make("openDiffViewer") as ExecuteDeps["openDiffViewer"],
    openTreeViewer: make("openTreeViewer") as ExecuteDeps["openTreeViewer"],
    copyToClipboard: vi.fn(async () => {}) as ExecuteDeps["copyToClipboard"],
    getAvailableModels: () =>
      [
        { id: "claude-sonnet-4", provider: "anthropic", name: "Claude Sonnet 4" },
        { id: "deepseek-v3", provider: "deepseek", name: "DeepSeek V3" },
        { id: "claude-haiku", provider: "anthropic", name: "Claude Haiku" },
      ] as never,
    getSessionName: () => "Existing Name",
    setSessionName: make("setSessionName") as ExecuteDeps["setSessionName"],
    getCurrentModel: () => "claude-sonnet-4",
    isWorking: () => false,
    getSessionWorkspacePath: () => "/tmp/ws",
    listSessions: vi.fn(async () => []) as ExecuteDeps["listSessions"],
    ...overrides,
  };
  return { deps, calls };
}

describe("executeAction — model", () => {
  it("/model (no arg) opens the model picker with no search", async () => {
    const { deps, calls } = makeDeps();
    await executeAction(SID, { kind: "model" }, deps);
    expect(calls["openPicker"]).toEqual([[SID, { kind: "model" }]]);
  });

  it("/model <search> with exact canonical match (provider/id) applies the model via applyModelChange", async () => {
    const { deps, calls } = makeDeps();
    await executeAction(SID, { kind: "model", search: "anthropic/claude-haiku" }, deps);
    expect(calls["applyModelChange"]).toEqual([
      [
        SID,
        { id: "claude-haiku", provider: "anthropic", name: "Claude Haiku" },
        { hostInstanceId: "host-1", sessionEpoch: 1 },
      ],
    ]);
    expect(calls["invoke"]).toBeUndefined();
    expect(calls["openPicker"]).toBeUndefined();
  });

  it("/model <search> with exact id (case-insensitive) applies the model via applyModelChange", async () => {
    const { deps, calls } = makeDeps();
    await executeAction(SID, { kind: "model", search: "DEEPSEEK-V3" }, deps);
    expect(calls["applyModelChange"]).toEqual([
      [
        SID,
        { id: "deepseek-v3", provider: "deepseek", name: "DeepSeek V3" },
        { hostInstanceId: "host-1", sessionEpoch: 1 },
      ],
    ]);
    expect(calls["invoke"]).toBeUndefined();
  });

  it("/model <providerless-id> applies the model directly when the id is unique", async () => {
    const { deps, calls } = makeDeps({
      getAvailableModels: () =>
        [
          { id: "local-model", name: "Local Model" },
          { id: "deepseek-v3", provider: "deepseek", name: "DeepSeek V3" },
        ] as never,
    });
    await executeAction(SID, { kind: "model", search: "local-model" }, deps);
    expect(calls["applyModelChange"]).toEqual([
      [
        SID,
        { id: "local-model", name: "Local Model" },
        { hostInstanceId: "host-1", sessionEpoch: 1 },
      ],
    ]);
    expect(calls["openPicker"]).toBeUndefined();
  });

  it("/model <search> with no match opens the picker (search prefilled)", async () => {
    const { deps, calls } = makeDeps();
    await executeAction(SID, { kind: "model", search: "nope" }, deps);
    expect(calls["openPicker"]).toEqual([[SID, { kind: "model", search: "nope" }]]);
  });

  it("/model <search> ambiguous across providers opens the picker", async () => {
    const { deps, calls } = makeDeps();
    await executeAction(SID, { kind: "model", search: "claude" }, deps);
    expect(calls["openPicker"]).toBeDefined();
  });
});

describe("executeAction — name", () => {
  it("/name <name> sends set_session_name", async () => {
    const { deps, calls } = makeDeps();
    await executeAction(SID, { kind: "name", name: "Hello" }, deps);
    expect(calls["invoke"]).toEqual([
      [{ sessionId: SID, command: { type: "set_session_name", name: "Hello" } }],
    ]);
    expect(calls["setSessionName"]).toEqual([[SID, "Hello"]]);
    expect(calls["addToast"]).toEqual([[SID, "Session name set: Hello"]]);
  });

  it("/name <name> toasts an error when pi rejects the rename", async () => {
    const { deps, calls } = makeDeps();
    (deps.invoke as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: false,
      error: "name is reserved",
    });
    await executeAction(SID, { kind: "name", name: "Hello" }, deps);
    expect(calls["addToast"]).toEqual([[SID, "name is reserved", "error"]]);
  });

  it("/name with no arg shows current name when one is set", async () => {
    const { deps, calls } = makeDeps();
    await executeAction(SID, { kind: "name" }, deps);
    expect(calls["invoke"]).toBeUndefined();
    expect(calls["addToast"]).toEqual([[SID, "Session name: Existing Name"]]);
  });

  it("/name with no arg and no current name shows usage", async () => {
    const { deps, calls } = makeDeps({ getSessionName: () => undefined });
    await executeAction(SID, { kind: "name" }, deps);
    expect(calls["addToast"]).toEqual([[SID, "Usage: /name <name>", "warning"]]);
  });
});

describe("executeAction — copy", () => {
  it("/copy with text puts it on the clipboard", async () => {
    const { deps, calls } = makeDeps();
    // Override invoke to return a text payload.
    (deps.invoke as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      data: { text: "the last agent message" },
    });
    await executeAction(SID, { kind: "copy" }, deps);
    expect(calls["addToast"]).toEqual([[SID, "Copied last agent message to clipboard"]]);
  });

  it("/copy with no last message shows warning", async () => {
    const { deps, calls } = makeDeps();
    (deps.invoke as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      data: { text: null },
    });
    await executeAction(SID, { kind: "copy" }, deps);
    expect(calls["addToast"]).toEqual([[SID, "No agent messages to copy yet.", "warning"]]);
  });
});

describe("executeAction — quit / settings / unsupported", () => {
  it("/quit calls closeSessionTab", async () => {
    const { deps, calls } = makeDeps();
    await executeAction(SID, { kind: "quit" }, deps);
    expect(calls["closeSessionTab"]).toEqual([[SID]]);
  });

  it("/settings opens the app settings panel", async () => {
    const { deps, calls } = makeDeps();
    await executeAction(SID, { kind: "open-app-settings" }, deps);
    expect(calls["openAppSettings"]).toEqual([[]]);
  });

  it("/login (unsupported) toasts without invoking", async () => {
    const { deps, calls } = makeDeps();
    await executeAction(SID, { kind: "unsupported", name: "login" }, deps);
    expect(calls["addToast"]).toEqual([
      [SID, "/login is not supported in pi-vis — use a terminal session.", "warning"],
    ]);
    expect(calls["invoke"]).toBeUndefined();
  });
});

describe("executeAction — reload", () => {
  it("/reload invokes session.reload and toasts success", async () => {
    const { deps, calls } = makeDeps();
    (deps.invoke as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      successorIdentity: { hostInstanceId: "host-1", sessionEpoch: 2 },
    });
    await expect(executeAction(SID, { kind: "reload" }, deps)).resolves.toEqual({
      completionRuntime: { hostInstanceId: "host-1", sessionEpoch: 2 },
    });
    expect(deps.invoke).toHaveBeenCalledWith("session.reload", { sessionId: SID });
    expect(calls["addToast"]).toEqual([
      [SID, "Reloaded settings, extensions, skills, prompts, and themes.", "success"],
    ]);
  });

  it("/reload warns and does not invoke while streaming", async () => {
    const { deps, calls } = makeDeps({ isWorking: () => true });
    await executeAction(SID, { kind: "reload" }, deps);
    expect(calls["invoke"]).toBeUndefined();
    expect(calls["addToast"]).toEqual([
      [SID, "Wait for the current response to finish before reloading.", "warning"],
    ]);
  });

  it("/reload toasts error when the reload fails", async () => {
    const { deps, calls } = makeDeps({
      invoke: vi.fn(async () => ({
        success: false,
        error: "pi binary not found",
      })) as ExecuteDeps["invoke"],
    });
    await executeAction(SID, { kind: "reload" }, deps);
    expect(calls["addToast"]).toEqual([[SID, "pi binary not found", "error"]]);
  });
});

describe("executeAction — bash", () => {
  it("adds a bash block and waits for the command response", async () => {
    let resolve!: (value: { success: boolean; data: { output: string; exitCode: number } }) => void;
    const response = new Promise<{ success: boolean; data: { output: string; exitCode: number } }>(
      (done) => {
        resolve = done;
      },
    );
    const { deps, calls } = makeDeps({ invoke: vi.fn(() => response) as ExecuteDeps["invoke"] });
    const execution = executeAction(
      SID,
      { kind: "bash", command: "ls", excludeFromContext: false },
      deps,
    );
    expect(calls["addBashCommand"]).toEqual([[SID, "ls"]]);
    expect(calls["finishBashCommand"]).toBeUndefined();
    resolve({ success: true, data: { output: "done", exitCode: 0 } });
    await execution;
    expect(calls["finishBashCommand"]).toEqual([[SID, "done", 0]]);
  });
});

describe("executeAction — session submission", () => {
  it("submits the host-custody contract and leaves immediate prompts event-derived", async () => {
    const { deps, calls } = makeDeps();
    await executeAction(SID, { kind: "send-prompt", text: "hello" }, deps);
    expect(deps.submit).toHaveBeenCalledWith(
      SID,
      expect.objectContaining({
        expectedHostId: "host-1",
        expectedEpoch: 1,
        editorRevision: 2,
        text: "hello",
        requestedMode: "steer",
        surface: "composer",
      }),
    );
    expect(calls["addUserMessage"]).toBeUndefined();
  });

  it("adds an optimistic echo for an accepted prompt waiting in Pi's queue", async () => {
    const { deps, calls } = makeDeps();
    (deps.submit as ReturnType<typeof vi.fn>).mockResolvedValue({
      intentId: "intent-1",
      hostInstanceId: "host-1",
      sessionEpoch: 1,
      editorRevision: 2,
      disposition: "consumed",
      queued: true,
    });

    await executeAction(SID, { kind: "send-prompt", text: "queued" }, deps);

    expect(calls["addUserMessage"]).toEqual([
      [SID, "queued", undefined, { registerEcho: true, afterUserMessageSequence: 0 }],
    ]);
  });

  it("does not add a queued echo after the runtime identity changes", async () => {
    const { deps, calls } = makeDeps();
    (deps.submit as ReturnType<typeof vi.fn>).mockResolvedValue({
      intentId: "intent-1",
      hostInstanceId: "host-1",
      sessionEpoch: 1,
      editorRevision: 2,
      disposition: "consumed",
      queued: true,
    });
    deps.getSubmissionContext = vi
      .fn()
      .mockReturnValueOnce({
        hostInstanceId: "host-1",
        sessionEpoch: 1,
        editorRevision: 2,
        userMessageSequence: 0,
      })
      .mockReturnValue({
        hostInstanceId: "host-2",
        sessionEpoch: 2,
        editorRevision: 0,
        userMessageSequence: 0,
      });

    await executeAction(SID, { kind: "send-prompt", text: "predecessor" }, deps);

    expect(calls["addUserMessage"]).toBeUndefined();
  });

  it("does not clear local input or add an echo for a rejected disposition", async () => {
    const { deps, calls } = makeDeps();
    (deps.submit as ReturnType<typeof vi.fn>).mockResolvedValue({
      intentId: "intent-1",
      hostInstanceId: "host-1",
      sessionEpoch: 1,
      editorRevision: 2,
      disposition: "rejected",
      message: "provider unavailable",
    });
    await expect(executeAction(SID, { kind: "send-prompt", text: "hello" }, deps)).rejects.toThrow(
      /provider unavailable/,
    );
    expect(calls["addUserMessage"]).toBeUndefined();
    expect(calls["clearPendingUserEcho"]).toBeUndefined();
  });

  it("does not submit when the direct runtime context is unavailable", async () => {
    const { deps, calls } = makeDeps({ getSubmissionContext: () => undefined });
    await expect(executeAction(SID, { kind: "send-prompt", text: "hello" }, deps)).rejects.toThrow(
      /snapshot is unavailable/,
    );
    expect(deps.submit).not.toHaveBeenCalled();
    expect(calls["addUserMessage"]).toBeUndefined();
  });

  it("passes extension commands through the same custody contract without an optimistic echo", async () => {
    const { deps } = makeDeps({ uiSurface: "unified" });
    await executeAction(
      SID,
      { kind: "send-prompt", text: "/mcp", commandSource: "extension" },
      deps,
    );
    expect(deps.submit).toHaveBeenCalledWith(
      SID,
      expect.objectContaining({ text: "/mcp", surface: "unified" }),
    );
  });
});

describe("executeAction — session-info", () => {
  it("surfaces transport rejection and leaves the command unconsumed", async () => {
    const { deps, calls } = makeDeps({
      invoke: vi.fn(async () => {
        throw new Error("Host exited with signal SIGTERM: fatal provider detail");
      }) as ExecuteDeps["invoke"],
    });
    await expect(executeAction(SID, { kind: "session-info" }, deps)).rejects.toThrow(
      "Host exited with signal SIGTERM",
    );
    expect(calls["addToast"]).toEqual([
      [SID, "Host exited with signal SIGTERM: fatal provider detail", "error"],
    ]);
    expect(calls["addCustomMessage"]).toBeUndefined();
  });

  it("surfaces a domain error instead of rendering fabricated session data", async () => {
    const { deps, calls } = makeDeps({
      invoke: vi.fn(async () => ({
        success: false,
        error: "stats unavailable",
      })) as ExecuteDeps["invoke"],
    });
    await executeAction(SID, { kind: "session-info" }, deps);
    expect(calls["addToast"]).toEqual([[SID, "stats unavailable", "error"]]);
    expect(calls["addCustomMessage"]).toBeUndefined();
  });

  it("renders a custom_message block (TUI parity for /session)", async () => {
    const { deps, calls } = makeDeps();
    (deps.invoke as ReturnType<typeof vi.fn>).mockImplementation(async (ch: string) => {
      if (ch === "session.sendCommand" && (calls["invoke"]?.length ?? 0) === 0) {
        return {
          success: true,
          data: {
            sessionId: "ses-x",
            sessionName: "Test",
            sessionFile: "/tmp/x.jsonl",
            tokens: { input: 100, output: 50, total: 150 },
            cost: 0.001,
            userMessages: 2,
            assistantMessages: 1,
            toolCalls: 0,
            toolResults: 0,
            totalMessages: 3,
          },
        };
      }
      return { success: true, data: {} };
    });
    await executeAction(SID, { kind: "session-info" }, deps);
    expect(calls["addCustomMessage"]).toBeDefined();
    const block = (calls["addCustomMessage"] as Array<[SessionId, string]>)[0]![1];
    expect(block).toContain("Session Info");
    expect(block).toContain("Test");
    expect(block).toContain("/tmp/x.jsonl");
  });
});

describe("executeAction — changelog", () => {
  it("/changelog opens the modal with the fetched markdown (not inline)", async () => {
    const { deps, calls } = makeDeps();
    (deps.invoke as ReturnType<typeof vi.fn>).mockImplementation(async (ch: string) => {
      if (ch === "pi.changelog") {
        // Real IPC returns this direct shape, not a {success,data} RPC envelope.
        return { ok: true, markdown: "# v1.2.3\n- change" };
      }
      return { success: true, data: {} };
    });
    await executeAction(SID, { kind: "changelog" }, deps);
    expect(calls["openChangelog"]).toEqual([["# v1.2.3\n- change"]]);
    // Must NOT dump inline in the transcript anymore.
    expect(calls["addCustomMessage"]).toBeUndefined();
  });

  it("/changelog toasts on failure and does not open the modal", async () => {
    const { deps, calls } = makeDeps();
    (deps.invoke as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      error: "changelog not found",
    });
    await executeAction(SID, { kind: "changelog" }, deps);
    expect(calls["addToast"]).toEqual([[SID, "changelog not found", "error"]]);
    expect(calls["openChangelog"]).toBeUndefined();
  });
});

describe("executeAction — share", () => {
  it("/share handles the direct IPC result, copies the URL, and toasts both links", async () => {
    const { deps, calls } = makeDeps();
    (deps.invoke as ReturnType<typeof vi.fn>).mockImplementation(async (ch: string) => {
      if (ch === "session.share") {
        // Real IPC returns this direct shape, not a {success,data} RPC envelope.
        return { ok: true, url: "https://pi.dev/share/abc", gistUrl: "https://gist.github.com/g" };
      }
      return { success: true, data: {} };
    });

    await executeAction(SID, { kind: "share" }, deps);

    expect(deps.copyToClipboard).toHaveBeenCalledWith("https://pi.dev/share/abc");
    expect(calls["addToast"]).toEqual([
      [SID, "Share URL: https://pi.dev/share/abc\nGist: https://gist.github.com/g", "success"],
    ]);
  });

  it("/share still shows the share URL when clipboard copy fails", async () => {
    const { deps, calls } = makeDeps();
    (deps.invoke as ReturnType<typeof vi.fn>).mockImplementation(async (ch: string) => {
      if (ch === "session.share") return { ok: true, url: "https://pi.dev/share/abc" };
      return { success: true, data: {} };
    });
    (deps.copyToClipboard as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("denied"));

    await executeAction(SID, { kind: "share" }, deps);

    expect(calls["addToast"]).toEqual([
      [SID, "Share URL: https://pi.dev/share/abc\nClipboard copy failed: denied", "success"],
    ]);
  });

  it("/share toasts direct IPC failures", async () => {
    const { deps, calls } = makeDeps();
    (deps.invoke as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      error: "gh not logged in",
    });

    await executeAction(SID, { kind: "share" }, deps);

    expect(deps.copyToClipboard).not.toHaveBeenCalled();
    expect(calls["addToast"]).toEqual([[SID, "gh not logged in", "error"]]);
  });
});

describe("executeAction — new-session / fork", () => {
  it("/new returns its acknowledged successor runtime", async () => {
    const { deps, calls } = makeDeps();
    (deps.invoke as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      data: { cancelled: false },
      successorIdentity: { hostInstanceId: "host-1", sessionEpoch: 2 },
    });
    await expect(executeAction(SID, { kind: "new-session" }, deps)).resolves.toEqual({
      completionRuntime: { hostInstanceId: "host-1", sessionEpoch: 2 },
    });
    expect(calls["addToast"]).toEqual([[SID, "Started a fresh session"]]);
  });

  it("/fork with no messages toasts 'No messages to fork from'", async () => {
    const { deps, calls } = makeDeps();
    (deps.invoke as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      data: { messages: [] },
    });
    await executeAction(SID, { kind: "fork" }, deps);
    expect(calls["addToast"]).toEqual([[SID, "No messages to fork from", "warning"]]);
    expect(calls["openPicker"]).toBeUndefined();
  });

  it("/fork with messages opens the fork picker", async () => {
    const { deps, calls } = makeDeps();
    (deps.invoke as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      data: {
        messages: [
          { entryId: "e1", text: "first message" },
          { entryId: "e2", text: "second message" },
        ],
      },
    });
    await executeAction(SID, { kind: "fork" }, deps);
    expect(calls["openPicker"]).toEqual([
      [
        SID,
        {
          kind: "fork",
          messages: [
            { entryId: "e1", text: "first message" },
            { entryId: "e2", text: "second message" },
          ],
        },
      ],
    ]);
  });
});

describe("executeAction — outcome-specific built-ins", () => {
  it("/compact surfaces a correlated Pi domain failure", async () => {
    const { deps, calls } = makeDeps({
      invoke: vi.fn(async () => ({
        success: false,
        error: "Nothing to compact",
      })) as ExecuteDeps["invoke"],
    });
    await executeAction(SID, { kind: "compact" }, deps);
    expect(calls["addToast"]).toEqual([[SID, "Nothing to compact", "error"]]);
  });

  it("/export reports the authoritative output path", async () => {
    const { deps, calls } = makeDeps({
      invoke: vi.fn(async () => ({
        success: true,
        data: { path: "/tmp/export.html" },
      })) as ExecuteDeps["invoke"],
    });
    await executeAction(SID, { kind: "export", outputPath: "/tmp/export.html" }, deps);
    expect(calls["addToast"]).toEqual([[SID, "Session exported to: /tmp/export.html"]]);
  });

  it("/clone distinguishes a successful replacement from a domain failure", async () => {
    const success = makeDeps({
      invoke: vi.fn(async () => ({
        success: true,
        data: { cancelled: false },
        successorIdentity: { hostInstanceId: "host-1", sessionEpoch: 2 },
      })) as ExecuteDeps["invoke"],
    });
    await expect(executeAction(SID, { kind: "clone" }, success.deps)).resolves.toEqual({
      completionRuntime: { hostInstanceId: "host-1", sessionEpoch: 2 },
    });
    expect(success.calls["addToast"]).toEqual([[SID, "Cloned to new session"]]);

    const failure = makeDeps({
      invoke: vi.fn(async () => ({
        success: false,
        error: "Cannot clone an empty session",
      })) as ExecuteDeps["invoke"],
    });
    await executeAction(SID, { kind: "clone" }, failure.deps);
    expect(failure.calls["addToast"]).toEqual([[SID, "Cannot clone an empty session", "error"]]);
  });

  it("/scoped-models opens only from a successful model-state response", async () => {
    const { deps, calls } = makeDeps({
      invoke: vi.fn(async () => ({
        success: true,
        data: { models: [{ id: "m", provider: "p" }], enabledIds: ["p/m"] },
      })) as ExecuteDeps["invoke"],
    });
    await executeAction(SID, { kind: "scoped-models" }, deps);
    expect(calls["openPicker"]).toEqual([
      [SID, expect.objectContaining({ kind: "scoped-models", enabledIds: ["p/m"] })],
    ]);
  });

  it("/logout opens the provider picker from the host result", async () => {
    const { deps, calls } = makeDeps({
      invoke: vi.fn(async () => ({
        success: true,
        data: { providers: [{ id: "p", name: "Provider", authType: "api_key" }] },
      })) as ExecuteDeps["invoke"],
    });
    await executeAction(SID, { kind: "logout" }, deps);
    expect(calls["openPicker"]).toEqual([
      [
        SID,
        expect.objectContaining({
          kind: "logout",
          providers: [expect.objectContaining({ id: "p" })],
        }),
      ],
    ]);
  });

  it("/trust opens the exact host-provided choice set", async () => {
    const option = { label: "Trust folder", trusted: true, updates: [] };
    const { deps, calls } = makeDeps({
      invoke: vi.fn(async () => ({
        success: true,
        data: {
          cwd: "/tmp/ws",
          savedDecision: null,
          projectTrusted: false,
          hasTrustRequiringResources: true,
          currentOptions: [option],
        },
      })) as ExecuteDeps["invoke"],
    });
    await executeAction(SID, { kind: "trust" }, deps);
    expect(calls["openPicker"]).toEqual([
      [SID, expect.objectContaining({ kind: "trust", options: [option] })],
    ]);
  });

  it.each([
    [{ kind: "open-app-settings" }, "openAppSettings"],
    [{ kind: "open-login" }, "openLogin"],
    [{ kind: "git-diff" }, "openDiffViewer"],
    [{ kind: "open-tree" }, "openTreeViewer"],
  ] as const)("dispatches local action %o", async (action, call) => {
    const { deps, calls } = makeDeps();
    await executeAction(SID, action, deps);
    expect(calls[call]).toBeDefined();
    expect(calls["invoke"]).toBeUndefined();
  });
});

describe("executeAction — unsupported exposes nothing via invoke", () => {
  it.each(["import", "hotkeys", "debug"])("always toasts for /%s", async (name) => {
    const { deps, calls } = makeDeps();
    await executeAction(SID, { kind: "unsupported", name } as ComposerAction, deps);
    expect(calls["invoke"]).toBeUndefined();
    expect(calls["addToast"]).toEqual([
      [SID, `/${name} is not supported in pi-vis — use a terminal session.`, "warning"],
    ]);
  });
});

describe("executeAction — picker host receives a well-typed PickerRequest", () => {
  it("/resume opens the resume picker with the workspace sessions", async () => {
    const fixture = [
      {
        filePath: "/tmp/a.jsonl",
        id: "ses-a",
        mtime: 0,
        preview: "preview",
        messageCount: 4,
        cwd: "/tmp",
      },
    ];
    const { deps, calls } = makeDeps({
      listSessions: vi.fn(async () => fixture) as ExecuteDeps["listSessions"],
    });
    await executeAction(SID, { kind: "resume" }, deps);
    const picker = (calls["openPicker"] as Array<[SessionId, PickerRequest]>)[0]![1];
    expect(picker.kind).toBe("resume");
    if (picker.kind === "resume") expect(picker.sessions.length).toBe(1);
  });
});
