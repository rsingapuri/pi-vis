/**
 * parseComposerInput — pure mapping from composer text to a ComposerAction.
 *
 * The matching order mirrors the TUI's interactive-mode.js:2014-2160 switch
 * so that the visible behaviour matches. The three layers are:
 *
 *   1. Bash: `!` / `!!` prefix → `bash` action. (TUI branches on this last,
 *      but it's a substring test independent of slash handling, so we test
 *      it first; nothing else can claim the input.)
 *   2. Built-ins: matched exact, then with args. An arg-less built-in
 *      ("/session") with trailing text falls through — the TUI's `if
 *      (text === "/session")` check fails, and the unrecognised string
 *      drops to the prompt path. We follow the same fall-through.
 *   3. Discovered: extension / prompt / skill commands from `get_commands`.
 *      Built-ins retain precedence, matching autocomplete; discovered commands
 *      handle non-built-in names, including unsupported TUI-name collisions.
 *      Skills are surfaced with `commandSource: "skill"` so the executor can
 *      mark them appropriately; the slash is stripped from the text pi sees
 *      (pi expands them itself).
 *   4. Default: any other `/x` is sent as a plain prompt — pi's TUI does
 *      the same for unknown slashes (docs explicitly say built-ins are
 *      TUI-only and would not execute if sent via `prompt`).
 *   5. Plain text → `send-prompt`.
 *
 * `commandSource` is the discovered source ("extension" | "prompt" |
 * "skill"); it tells the executor not to add an optimistic user bubble and
 * to skip the working spinner for extension commands (which may complete
 * without ever emitting agent_start).
 */

import type { SlashCommandInfo } from "@shared/pi-protocol/responses.js";
import { BUILTIN_BY_NAME, UNSUPPORTED_TUI_COMMANDS } from "./builtins.js";
import type { ComposerAction } from "./types.js";

export interface ParseContext {
  /**
   * Map of discovered command name → source. Populated from
   * `get_commands`. Skills surface with `commandSource: "skill"`.
   */
  discovered: Map<string, SlashCommandInfo>;
}

export function parseComposerInput(rawText: string, ctx: ParseContext): ComposerAction {
  const text = rawText;

  // ── 1. Bash ─────────────────────────────────────────────────────────
  if (text.startsWith("!")) {
    const isExcluded = text.startsWith("!!");
    const command = isExcluded ? text.slice(2).trim() : text.slice(1).trim();
    if (command) {
      return { kind: "bash", command, excludeFromContext: isExcluded };
    }
    // "! " with no command is meaningless; fall through to plain text.
  }

  // ── Non-slash plain text ──────────────────────────────────────────
  if (!text.startsWith("/")) {
    return { kind: "send-prompt", text };
  }

  // Split into command + rest. The TUI's matching is character-exact
  // (no tabs allowed) — " " is the only separator.
  const spaceIdx = text.indexOf(" ");
  const bare = spaceIdx === -1 ? text : text.slice(0, spaceIdx);
  const rest = spaceIdx === -1 ? "" : text.slice(spaceIdx + 1);
  // Slash is required by construction; strip it for the lookup.
  const name = bare.slice(1);
  if (!name) return { kind: "send-prompt", text };

  // ── 2. Built-in match — wins over discovered collisions ──────────
  const builtin = BUILTIN_BY_NAME.get(name);
  if (builtin) {
    return matchBuiltin(builtin, rest);
  }

  // ── 3. Discovered (extension / prompt / skill) ────────────────────
  // Built-ins above own their names; discovered commands may handle all
  // remaining names, including unsupported TUI-command collisions.
  const disc = ctx.discovered.get(name);
  if (disc) {
    const commandSource = normalizeCommandSource(disc.source);
    if (commandSource) {
      return { kind: "send-prompt", text, commandSource };
    }
    return { kind: "send-prompt", text };
  }

  // ── 4. Unsupported TUI command ────────────────────────────────────
  if (UNSUPPORTED_TUI_COMMANDS.has(name)) {
    return { kind: "unsupported", name };
  }

  // ── 5. Unknown slash — passthrough as prompt ──────────────────────
  return { kind: "send-prompt", text };
}

function matchBuiltin(def: { name: string; takesArgs: boolean }, rest: string): ComposerAction {
  const name = def.name;
  const trimmedRest = rest.trim();

  // Arg-less built-ins only match the bare token. TUI behaviour: a stray
  // "/session extra" falls through to prompt-passthrough.
  if (!def.takesArgs) {
    if (trimmedRest.length > 0) {
      return { kind: "send-prompt", text: `/${name} ${rest}` };
    }
    return dispatchArgless(name);
  }

  // Arg-accepting built-ins match bare or `/<name> <args>`. With
  // `exactOptionalPropertyTypes` we omit the optional field rather than
  // assigning `undefined`.
  switch (name) {
    case "model": {
      const action: ComposerAction =
        trimmedRest.length > 0 ? { kind: "model", search: trimmedRest } : { kind: "model" };
      return action;
    }
    case "name": {
      const action: ComposerAction =
        trimmedRest.length > 0 ? { kind: "name", name: trimmedRest } : { kind: "name" };
      return action;
    }
    case "compact": {
      const action: ComposerAction =
        trimmedRest.length > 0
          ? { kind: "compact", customInstructions: trimmedRest }
          : { kind: "compact" };
      return action;
    }
    case "export": {
      const action: ComposerAction =
        trimmedRest.length > 0 ? { kind: "export", outputPath: trimmedRest } : { kind: "export" };
      return action;
    }
    default:
      // Unreachable; BUILTIN_COMMANDS is the source of truth.
      return { kind: "send-prompt", text: `/${name} ${rest}` };
  }
}

function dispatchArgless(name: string): ComposerAction {
  switch (name) {
    case "session":
      return { kind: "session-info" };
    case "new":
      return { kind: "new-session" };
    case "fork":
      return { kind: "fork" };
    case "clone":
      return { kind: "clone" };
    case "resume":
      return { kind: "resume" };
    case "copy":
      return { kind: "copy" };
    case "quit":
      return { kind: "quit" };
    case "reload":
      return { kind: "reload" };
    case "scoped-models":
      return { kind: "scoped-models" };
    case "logout":
      return { kind: "logout" };
    case "settings":
      return { kind: "open-app-settings" };
    case "login":
      return { kind: "open-login" };
    case "diff":
      return { kind: "git-diff" };
    case "trust":
      return { kind: "trust" };
    case "share":
      return { kind: "share" };
    case "changelog":
      return { kind: "changelog" };
    case "tree":
      return { kind: "open-tree" };
    default:
      return { kind: "send-prompt", text: `/${name}` };
  }
}

function normalizeCommandSource(
  source: string | undefined,
): "extension" | "prompt" | "skill" | undefined {
  if (source === "extension" || source === "prompt" || source === "skill") return source;
  return undefined;
}
