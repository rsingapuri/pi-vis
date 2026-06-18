/**
 * ComposerAction — pure command-dispatch union used by the Composer.
 *
 * Parsing (parse.ts) maps a raw composer string into one of these actions;
 * execution (execute.ts) runs the action against injected deps (RPC, store,
 * clipboard, settings). Keeping these layers separate makes the parser
 * trivially unit-testable and the executor injectable — no React, no IPC.
 *
 * Shape parity with real pi's TUI dispatcher (interactive-mode.js:2014-2160)
 * is the spec: every `/cmd` in that switch becomes one of these actions.
 */

export type ComposerAction =
  // Plain text / undiscovered `/foo` — flows to the agent as a prompt.
  // `commandSource` is set when the slash is recognised (extension, prompt
  // template, skill) so the executor can avoid optimistic user bubbles for
  // // extensions that immediately replace the editor.
  | {
      kind: "send-prompt";
      text: string;
      commandSource?: "extension" | "prompt" | "skill";
      images?: Array<{ data: string; mimeType: string; dataUrl: string }>;
    }
  // Bash: "!" runs normally, "!!" runs with excludeFromContext (TUI parity).
  | { kind: "bash"; command: string; excludeFromContext: boolean }
  // Built-in slash commands. Each variant carries the exact parsed argument
  // shape TUI would extract; executeAction turns them into RPC calls.
  | { kind: "model"; search?: string }
  | { kind: "name"; name?: string }
  | { kind: "session-info" }
  | { kind: "new-session" }
  | { kind: "compact"; customInstructions?: string }
  | { kind: "export"; outputPath?: string }
  | { kind: "fork" }
  | { kind: "clone" }
  | { kind: "resume" }
  | { kind: "copy" }
  | { kind: "quit" }
  | { kind: "reload" }
  | { kind: "open-app-settings" }
  | { kind: "open-login" }
  | { kind: "git-diff" }
  // TUI-only commands we deliberately do not surface. The renderer toasts
  // an "unsupported" notice unless a discovered command shadows the name.
  | { kind: "unsupported"; name: string };
