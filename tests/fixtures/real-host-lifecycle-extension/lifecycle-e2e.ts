import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "e2e-lifecycle-status";
const WIDGET_KEY = "e2e-lifecycle-widget";
const CUSTOM_MESSAGE_TYPE = "e2e-lifecycle-message";
const CUSTOM_ENTRY_TYPE = "e2e-lifecycle-entry";
const INPUT_MARKER = "[[E2E_LIFECYCLE_TRANSFORM_MARKER]]";

// Keep this copied fixture dependency-free at runtime. TypeBox schemas are
// ordinary records plus the public `~kind` discriminator; this is equivalent
// to Type.Object({ value: Type.String(...) }) from Pi's bundled TypeBox.
const TOOL_PARAMETERS = {
  type: "object",
  required: ["value"],
  properties: {
    value: {
      type: "string",
      description: "Deterministic text to echo",
      "~kind": "String",
    },
  },
  "~kind": "Object",
} as never;

function lineComponent(text: string) {
  return {
    render: () => [text],
    invalidate() {},
  };
}

function requireUI(ctx: {
  hasUI: boolean;
  ui: { notify(message: string, type?: "info" | "warning" | "error"): void };
}): boolean {
  if (ctx.hasUI) return true;
  ctx.ui.notify("e2e lifecycle fixture requires an interactive UI", "warning");
  return false;
}

export default function lifecycleE2E(pi: ExtensionAPI) {
  pi.registerMessageRenderer(CUSTOM_MESSAGE_TYPE, (message, _options, theme) =>
    lineComponent(theme.fg("accent", `E2E custom message: ${String(message.content)}`)),
  );

  pi.registerEntryRenderer<{ label: string }>(CUSTOM_ENTRY_TYPE, (entry, _options, theme) => ({
    // The renderer may decline a width. Pi-Vis first probes at 80 columns, so
    // this fixture proves a hidden result is requeried at the measured pane
    // width rather than becoming permanently invisible.
    render: (width: number) =>
      width > 80
        ? [theme.fg("success", `E2E persisted entry: ${entry.data?.label ?? "missing"}`)]
        : (undefined as unknown as string[]),
    invalidate() {},
  }));

  pi.on("input", (event) => {
    if (event.source !== "extension" && event.text.includes(INPUT_MARKER)) {
      const text = event.text.replace(INPUT_MARKER, "[[E2E_LIFECYCLE_TRANSFORMED]]");
      return event.images
        ? { action: "transform", text, images: event.images }
        : { action: "transform", text };
    }
    return { action: "continue" };
  });

  pi.registerTool({
    name: "e2e-lifecycle-tool",
    label: "E2E lifecycle tool",
    description: "Safely returns deterministic fixture output without external effects.",
    parameters: TOOL_PARAMETERS,
    async execute(_toolCallId, params) {
      const value = (params as { value: string }).value;
      return {
        content: [
          { type: "text", text: "e2e-tool-adjacent-first" },
          { type: "text", text: `e2e-tool-adjacent-second:${value}` },
        ],
        details: {
          value,
          diff: "--- e2e-before\n+++ e2e-after\n- before\n+ after",
        },
      };
    },
  });

  pi.registerTool({
    name: "e2e-cancellable-tool",
    label: "E2E cancellable tool",
    description: "Waits until the real AgentSession abort signal cancels this fixture tool.",
    parameters: TOOL_PARAMETERS,
    async execute(_toolCallId, params, signal, onUpdate) {
      const value = (params as { value: string }).value;
      onUpdate?.({
        content: [{ type: "text", text: `e2e cancellable tool waiting:${value}` }],
        details: { phase: "waiting", value },
      });
      await new Promise<never>((_resolve, reject) => {
        const rejectAborted = () => {
          const error = new Error("e2e cancellable tool aborted");
          error.name = "AbortError";
          reject(error);
        };
        if (signal?.aborted) {
          rejectAborted();
          return;
        }
        signal?.addEventListener("abort", rejectAborted, { once: true });
      });
      return {
        content: [{ type: "text", text: "e2e cancellable tool unexpectedly completed" }],
        details: { phase: "unexpected-completion", value },
      };
    },
  });

  pi.registerCommand("e2e-notify", {
    description: "Show a deterministic lifecycle-fixture notification",
    handler: async (_args, ctx) => {
      ctx.ui.notify("e2e lifecycle notification", "info");
    },
  });

  pi.registerCommand("e2e-status-on", {
    description: "Enable the lifecycle-fixture status text",
    handler: async (_args, ctx) => {
      ctx.ui.setStatus(STATUS_KEY, "e2e lifecycle status enabled");
    },
  });

  pi.registerCommand("e2e-status-off", {
    description: "Clear the lifecycle-fixture status text",
    handler: async (_args, ctx) => {
      ctx.ui.setStatus(STATUS_KEY, undefined);
    },
  });

  pi.registerCommand("e2e-widget-on", {
    description: "Display the lifecycle-fixture widget",
    handler: async (_args, ctx) => {
      ctx.ui.setWidget(WIDGET_KEY, ["e2e lifecycle widget enabled"], { placement: "belowEditor" });
    },
  });

  pi.registerCommand("e2e-widget-off", {
    description: "Remove the lifecycle-fixture widget",
    handler: async (_args, ctx) => {
      ctx.ui.setWidget(WIDGET_KEY, undefined);
    },
  });

  pi.registerCommand("e2e-set-editor-text", {
    description: "Set deterministic text in the input editor",
    handler: async (_args, ctx) => {
      ctx.ui.setEditorText("e2e lifecycle editor text");
    },
  });

  pi.registerCommand("e2e-select", {
    description: "Open a deterministic select dialog",
    handler: async (_args, ctx) => {
      if (!requireUI(ctx)) return;
      const value = await ctx.ui.select("E2E select dialog", [
        "e2e-option-alpha",
        "e2e-option-beta",
      ]);
      ctx.ui.notify(`e2e select result: ${value ?? "cancelled"}`, "info");
    },
  });

  pi.registerCommand("e2e-confirm", {
    description: "Open a deterministic confirmation dialog",
    handler: async (_args, ctx) => {
      if (!requireUI(ctx)) return;
      const confirmed = await ctx.ui.confirm(
        "E2E confirm dialog",
        "Confirm the lifecycle fixture dialog.",
      );
      ctx.ui.notify(`e2e confirm result: ${confirmed ? "confirmed" : "cancelled"}`, "info");
    },
  });

  pi.registerCommand("e2e-input", {
    description: "Open a deterministic text-input dialog",
    handler: async (_args, ctx) => {
      if (!requireUI(ctx)) return;
      const value = await ctx.ui.input("E2E input dialog", "e2e input placeholder");
      ctx.ui.notify(`e2e input result: ${value ?? "cancelled"}`, "info");
    },
  });

  pi.registerCommand("e2e-editor", {
    description: "Open a deterministic multi-line editor dialog",
    handler: async (_args, ctx) => {
      if (!requireUI(ctx)) return;
      const value = await ctx.ui.editor(
        "E2E editor dialog",
        "e2e editor line 1\ne2e editor line 2",
      );
      ctx.ui.notify(`e2e editor result: ${value ?? "cancelled"}`, "info");
    },
  });

  pi.registerCommand("e2e-throw", {
    description: "Throw a deterministic command error through Pi's extension-error boundary",
    handler: async () => {
      throw new Error("e2e lifecycle command error");
    },
  });

  pi.registerCommand("e2e-custom-message", {
    description: "Send a visible custom lifecycle-fixture message",
    handler: async () => {
      pi.sendMessage({
        customType: CUSTOM_MESSAGE_TYPE,
        content: "e2e visible custom message",
        display: true,
        details: { fixture: "e2e-lifecycle" },
      });
    },
  });

  pi.registerCommand("e2e-custom-entry", {
    description: "Append a persisted custom lifecycle-fixture entry",
    handler: async () => {
      pi.appendEntry(CUSTOM_ENTRY_TYPE, { label: "e2e persisted lifecycle entry" });
    },
  });
}
