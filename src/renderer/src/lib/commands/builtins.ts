/**
 * Built-in TUI commands — mirrored from pi's interactive-mode.js:2014-2160.
 * Each definition is a (name, argHint, description, takesArgs) tuple used by
 * both the parser (exact match / arg extraction) and the suggestions list
 * (display label + description + arg hint).
 *
 * `takesArgs` is true when the command accepts free-form text after a
 * single space; e.g. "/name <name>", "/compact <instructions>". Arg-less
 * commands (e.g. "/session", "/new") only match the bare token — the
 * TUI's `if (text === "/name" || text.startsWith("/name "))` pattern.
 */

export interface BuiltinCommandDef {
  readonly name: string;
  readonly argHint: string;
  readonly description: string;
  readonly takesArgs: boolean;
}

export const BUILTIN_COMMANDS: readonly BuiltinCommandDef[] = [
  {
    name: "model",
    argHint: "[search]",
    description: "Switch model or open picker",
    takesArgs: true,
  },
  { name: "name", argHint: "[name]", description: "Get or set the session name", takesArgs: true },
  { name: "session", argHint: "", description: "Show session info in the chat", takesArgs: false },
  { name: "new", argHint: "", description: "Start a fresh session", takesArgs: false },
  {
    name: "compact",
    argHint: "[instructions]",
    description: "Compact context with optional instructions",
    takesArgs: true,
  },
  { name: "export", argHint: "[path]", description: "Export session to HTML", takesArgs: true },
  { name: "fork", argHint: "", description: "Fork from a user message", takesArgs: false },
  { name: "clone", argHint: "", description: "Duplicate the active branch", takesArgs: false },
  { name: "resume", argHint: "", description: "Resume a stored session", takesArgs: false },
  {
    name: "copy",
    argHint: "",
    description: "Copy last assistant message to clipboard",
    takesArgs: false,
  },
  { name: "quit", argHint: "", description: "Close the current tab", takesArgs: false },
  { name: "settings", argHint: "", description: "Open app settings", takesArgs: false },
  { name: "diff", argHint: "", description: "View working tree changes", takesArgs: false },
  { name: "login", argHint: "", description: "Sign in to a provider", takesArgs: false },
];

/**
 * Commands the TUI dispatches locally that we deliberately do not implement
 * over RPC. The renderer toasts "not supported in pi-vis" for these — unless
 * a discovered extension/prompt/skill happens to share the same name, in
 * which case the discovered command wins (the user has installed a drop-in).
 */
export const UNSUPPORTED_TUI_COMMANDS: ReadonlySet<string> = new Set([
  "logout",
  "trust",
  "share",
  "import",
  "tree",
  "changelog",
  "hotkeys",
  "debug",
  "reload",
  "scoped-models",
]);

/**
 * Lookup table: name → definition. Arg-less built-ins are matched only on
 * the exact token (no trailing text); arg-accepting built-ins match the bare
 * name AND `/<name> <args>`.
 */
export const BUILTIN_BY_NAME: ReadonlyMap<string, BuiltinCommandDef> = new Map(
  BUILTIN_COMMANDS.map((c) => [c.name, c]),
);
