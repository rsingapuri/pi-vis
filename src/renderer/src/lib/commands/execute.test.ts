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
    setStreaming: make("setStreaming") as ExecuteDeps["setStreaming"],
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
    getCurrentModel: () => "claude-sonnet-4",
    isStreaming: () => false,
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
      [SID, { id: "claude-haiku", provider: "anthropic", name: "Claude Haiku" }],
    ]);
    expect(calls["invoke"]).toBeUndefined();
    expect(calls["openPicker"]).toBeUndefined();
  });

  it("/model <search> with exact id (case-insensitive) applies the model via applyModelChange", async () => {
    const { deps, calls } = makeDeps();
    await executeAction(SID, { kind: "model", search: "DEEPSEEK-V3" }, deps);
    expect(calls["applyModelChange"]).toEqual([
      [SID, { id: "deepseek-v3", provider: "deepseek", name: "DeepSeek V3" }],
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
    expect(calls["applyModelChange"]).toEqual([[SID, { id: "local-model", name: "Local Model" }]]);
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
    await executeAction(SID, { kind: "reload" }, deps);
    expect(calls["invoke"]).toEqual([[{ sessionId: SID }]]);
    expect(calls["addToast"]).toEqual([
      [SID, "Reloaded settings, extensions, skills, prompts, and themes.", "success"],
    ]);
  });

  it("/reload warns and does not invoke while streaming", async () => {
    const { deps, calls } = makeDeps({ isStreaming: () => true });
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
  it("adds a bash block and runs the command", async () => {
    const { deps, calls } = makeDeps();
    await executeAction(SID, { kind: "bash", command: "ls", excludeFromContext: false }, deps);
    expect(calls["addBashCommand"]).toEqual([[SID, "ls"]]);
  });
});

describe("executeAction — send-prompt vs steer", () => {
  it("sends a `prompt` command when idle", async () => {
    const { deps, calls } = makeDeps();
    await executeAction(SID, { kind: "send-prompt", text: "hello" }, deps);
    const invocations = (deps.invoke as ReturnType<typeof vi.fn>).mock.calls;
    const send = invocations.find((c) => c[0] === "session.sendCommand");
    expect(send).toBeDefined();
    expect(send![1].command.type).toBe("prompt");
    expect(calls["addUserMessage"]).toEqual([[SID, "hello", undefined, { registerEcho: true }]]);
    expect(calls["setStreaming"]).toEqual([[SID, true]]);
  });

  it("toasts and clears streaming when an idle prompt is rejected", async () => {
    const { deps, calls } = makeDeps();
    (deps.invoke as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: false,
      error: "provider unavailable",
    });
    await executeAction(SID, { kind: "send-prompt", text: "hello" }, deps);
    expect(calls["setStreaming"]).toEqual([
      [SID, true],
      [SID, false],
    ]);
    expect(calls["clearPendingUserEcho"]).toEqual([[SID, "hello"]]);
    expect(calls["addToast"]).toEqual([[SID, "provider unavailable", "error"]]);
  });

  it("toasts and clears streaming when an idle prompt send throws", async () => {
    const { deps, calls } = makeDeps();
    (deps.invoke as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("IPC channel closed"));
    await expect(executeAction(SID, { kind: "send-prompt", text: "hello" }, deps)).resolves.toBe(
      undefined,
    );
    expect(calls["setStreaming"]).toEqual([
      [SID, true],
      [SID, false],
    ]);
    expect(calls["clearPendingUserEcho"]).toEqual([[SID, "hello"]]);
    expect(calls["addToast"]).toEqual([[SID, "IPC channel closed", "error"]]);
  });

  it("throws after toast on unified prompt failure so the host restores editor text", async () => {
    const { deps, calls } = makeDeps({ uiSurface: "unified" });
    (deps.invoke as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: false,
      error: "provider unavailable",
    });

    await expect(executeAction(SID, { kind: "send-prompt", text: "hello" }, deps)).rejects.toThrow(
      /provider unavailable/,
    );
    expect(calls["setStreaming"]).toEqual([
      [SID, true],
      [SID, false],
    ]);
    expect(calls["addToast"]).toEqual([[SID, "provider unavailable", "error"]]);
  });

  it("sends a `steer` command (and does not set streaming) when already streaming", async () => {
    const { deps, calls } = makeDeps({ isStreaming: () => true });
    await executeAction(SID, { kind: "send-prompt", text: "actually do X" }, deps);
    const invocations = (deps.invoke as ReturnType<typeof vi.fn>).mock.calls;
    const send = invocations.find((c) => c[0] === "session.sendCommand");
    expect(send).toBeDefined();
    expect(send![1].command.type).toBe("steer");
    expect(send![1].command.message).toBe("actually do X");
    expect(calls["addUserMessage"]).toEqual([
      [SID, "actually do X", undefined, { registerEcho: false }],
    ]);
    // Streaming state must not be re-toggled mid-turn.
    expect(calls["setStreaming"]).toBeUndefined();
  });

  it("toasts when a steer command is rejected", async () => {
    const { deps, calls } = makeDeps({ isStreaming: () => true });
    (deps.invoke as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: false,
      error: "cannot steer now",
    });
    await executeAction(SID, { kind: "send-prompt", text: "actually do X" }, deps);
    expect(calls["setStreaming"]).toBeUndefined();
    expect(calls["clearPendingUserEcho"]).toEqual([[SID, "actually do X"]]);
    expect(calls["addToast"]).toEqual([[SID, "cannot steer now", "error"]]);
  });

  it("throws after toast on unified steer failure so the host restores editor text", async () => {
    const { deps, calls } = makeDeps({ isStreaming: () => true, uiSurface: "unified" });
    (deps.invoke as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: false,
      error: "cannot steer now",
    });

    await expect(
      executeAction(SID, { kind: "send-prompt", text: "actually do X" }, deps),
    ).rejects.toThrow(/cannot steer now/);
    expect(calls["setStreaming"]).toBeUndefined();
    expect(calls["clearPendingUserEcho"]).toEqual([[SID, "actually do X"]]);
    expect(calls["addToast"]).toEqual([[SID, "cannot steer now", "error"]]);
  });

  it("toasts when a steer command throws", async () => {
    const { deps, calls } = makeDeps({ isStreaming: () => true });
    (deps.invoke as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("session exited"));
    await expect(
      executeAction(SID, { kind: "send-prompt", text: "actually do X" }, deps),
    ).resolves.toBe(undefined);
    expect(calls["setStreaming"]).toBeUndefined();
    expect(calls["clearPendingUserEcho"]).toEqual([[SID, "actually do X"]]);
    expect(calls["addToast"]).toEqual([[SID, "session exited", "error"]]);
  });
});

describe("executeAction — session-info", () => {
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
  it("/new without cancellation toasts; fileChanged handles the rest", async () => {
    const { deps, calls } = makeDeps();
    (deps.invoke as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      data: { cancelled: false },
    });
    await executeAction(SID, { kind: "new-session" }, deps);
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

describe("executeAction — unsupported exposes nothing via invoke", () => {
  it.each(["import", "tree", "hotkeys", "debug"])("always toasts for /%s", async (name) => {
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

describe("executeAction — extension commands (fire-and-forget)", () => {
  it("dispatches extension command without awaiting the invoke (composer decoupling)", async () => {
    // The extension branch must NOT await the invoke — otherwise the composer
    // blocks until the custom() panel closes (done callback).
    let invokeResolved = false;
    let invokeResolve: (() => void) | null = null;

    const { deps, calls } = makeDeps({
      invoke: vi.fn(() => {
        return new Promise<unknown>((resolve) => {
          invokeResolve = () => {
            invokeResolved = true;
            resolve({ success: true, data: {} });
          };
        });
      }) as ExecuteDeps["invoke"],
    });

    const promise = executeAction(
      SID,
      {
        kind: "send-prompt",
        text: "/mcp",
        commandSource: "extension",
      },
      deps,
    );

    // The executeAction should return immediately (fire-and-forget)
    // WITHOUT waiting for the invoke to resolve.
    await promise;

    // At this point, executeAction has returned but invoke hasn't resolved.
    // This proves the composer doesn't block on extension commands.
    expect(invokeResolved).toBe(false);

    // Now resolve the invoke to clean up
    if (invokeResolve) (invokeResolve as () => void)();
    await new Promise((r) => setTimeout(r, 0));
    expect(invokeResolved).toBe(true);
  });

  it("tags extension prompts with the invoking UI surface", async () => {
    const { deps, calls } = makeDeps({ uiSurface: "composer" });

    await executeAction(
      SID,
      { kind: "send-prompt", text: "/mcp", commandSource: "extension" },
      deps,
    );

    expect(calls["invoke"]?.[0]).toEqual([
      {
        sessionId: SID,
        command: { type: "prompt", message: "/mcp" },
        uiSurface: "composer",
      },
    ]);
  });

  it("surfaces a rejected invoke as an error toast (P2-a: no silent failure)", async () => {
    // If the invoke rejects (session died, "No active process"), the
    // fire-and-forget catch must toast the error — not just console.error it
    // — so the user knows their extension invocation did nothing.
    const { deps, calls } = makeDeps({
      invoke: vi.fn(() => Promise.reject(new Error("No active process"))) as ExecuteDeps["invoke"],
    });

    await executeAction(
      SID,
      { kind: "send-prompt", text: "/mcp", commandSource: "extension" },
      deps,
    );
    // The catch runs async; let it flush.
    await new Promise((r) => setTimeout(r, 0));

    const addToastCalls = (calls["addToast"] ?? []) as unknown[];
    expect(addToastCalls.length).toBe(1);
    expect(addToastCalls[0]).toEqual([SID, expect.stringMatching(/No active process/), "error"]);
  });
});
