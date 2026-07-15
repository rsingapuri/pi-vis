import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// Keep this fixture self-contained when Pi loads it from the throwaway agent
// directory. This is the public pi-tui matchesKey Escape behavior for the
// bytes delivered by the panel bridge; importing pi-tui from an extension
// would incorrectly depend on a developer/host module-resolution layout.
const matchesKey = (data: string, key: "escape"): boolean =>
  key === "escape" && (data === "\u001b" || data === "\u001b[27;1;27~");

export const STATIC_DOCK_SENTINEL = "REAL-REGRESSION-STATIC-DOCK";
export const ABOVE_SENTINEL = "REAL-REGRESSION-FACTORY-ABOVE";
export const BELOW_SENTINEL = "REAL-REGRESSION-FACTORY-BELOW";
export const REPLACED_SENTINEL = "REAL-REGRESSION-FACTORY-REPLACED";
export const CUSTOM_SENTINEL = "REAL-REGRESSION-CUSTOM-OVERLAY";
export const CUSTOM_DONE_SENTINEL = "REAL-REGRESSION-CUSTOM-DONE";
export const NAME_SENTINEL = "REAL-REGRESSION-EXACT-SESSION-NAME";
export const WRONG_COMPACT_SENTINEL = "REAL-REGRESSION-WRONG-COMPACT-COLLISION";

const staticWidget = (ctx: ExtensionContext) => {
  ctx.ui.setWidget("real-regression-static-dock", [STATIC_DOCK_SENTINEL]);
};

const factory = (label: string, ctx: ExtensionContext) => () => ({
  render: () => [`${label} session=${ctx.sessionManager.getSessionId().slice(-8)}`],
  invalidate() {},
  dispose() {},
});

const installFactories = (ctx: ExtensionContext) => {
  ctx.ui.setWidget("real-regression-above", factory(ABOVE_SENTINEL, ctx), {
    placement: "aboveEditor",
  });
  ctx.ui.setWidget("real-regression-below", factory(BELOW_SENTINEL, ctx), {
    placement: "belowEditor",
  });
};

export default function realSdkRegressions(pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    if (!ctx.hasUI) return;
    staticWidget(ctx);
    installFactories(ctx);
  });

  pi.registerCommand("regression-replace-factory", {
    description: "Replace the real factory widget",
    handler: async (_args, ctx) => {
      ctx.ui.setWidget("real-regression-below", factory(REPLACED_SENTINEL, ctx), {
        placement: "belowEditor",
      });
    },
  });
  pi.registerCommand("regression-remove-above", {
    description: "Remove the above real factory widget",
    handler: async (_args, ctx) => ctx.ui.setWidget("real-regression-above", undefined),
  });
  pi.registerCommand("regression-remove-below", {
    description: "Remove the below real factory widget",
    handler: async (_args, ctx) => ctx.ui.setWidget("real-regression-below", undefined),
  });
  pi.registerCommand("regression-custom", {
    description: "Open a real custom overlay which completes on Escape",
    handler: async (_args, ctx) => {
      let completed = false;
      await ctx.ui.custom<void>(
        (_tui, _theme, _keybindings, done) => ({
          render: () => [CUSTOM_SENTINEL, "Press Escape to finish"],
          invalidate() {},
          handleInput(data) {
            if (matchesKey(data, "escape") && !completed) {
              completed = true;
              done();
            }
          },
        }),
        { overlay: true },
      );
      ctx.ui.notify(CUSTOM_DONE_SENTINEL, "info");
    },
  });
  pi.registerCommand("regression-name", {
    description: "Set the exact real regression session name",
    handler: async () => pi.setSessionName(NAME_SENTINEL),
  });
  // Pi's native /compact must win this discovered collision.
  pi.registerCommand("compact", {
    description: "Must be shadowed by Pi's built-in compact command",
    handler: async (_args, ctx) => ctx.ui.notify(WRONG_COMPACT_SENTINEL, "error"),
  });
}
