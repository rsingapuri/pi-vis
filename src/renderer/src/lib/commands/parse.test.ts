import type { SlashCommandInfo } from "@shared/pi-protocol/responses.js";
import { describe, expect, it } from "vitest";
import { parseComposerInput } from "./parse.js";

function disc(commands: Array<[string, string]>): Map<string, SlashCommandInfo> {
  const m = new Map<string, SlashCommandInfo>();
  for (const [name, source] of commands) {
    m.set(name, { name, source });
  }
  return m;
}

describe("parseComposerInput — bash", () => {
  it("!cmd → bash (excludeFromContext=false)", () => {
    const action = parseComposerInput("!ls -la", { discovered: new Map() });
    expect(action).toEqual({ kind: "bash", command: "ls -la", excludeFromContext: false });
  });

  it("!!cmd → bash (excludeFromContext=true)", () => {
    const action = parseComposerInput("!!npm test", { discovered: new Map() });
    expect(action).toEqual({ kind: "bash", command: "npm test", excludeFromContext: true });
  });

  it("trims whitespace from the command", () => {
    const action = parseComposerInput("!   pwd  ", { discovered: new Map() });
    expect(action).toEqual({ kind: "bash", command: "pwd", excludeFromContext: false });
  });
});

describe("parseComposerInput — plain text", () => {
  it("non-slash → send-prompt with the original text", () => {
    const action = parseComposerInput("hello world", { discovered: new Map() });
    expect(action).toEqual({ kind: "send-prompt", text: "hello world" });
  });

  it("'/' alone → send-prompt (no command name)", () => {
    const action = parseComposerInput("/", { discovered: new Map() });
    expect(action).toEqual({ kind: "send-prompt", text: "/" });
  });
});

describe("parseComposerInput — built-ins", () => {
  it("/model → model picker (no search)", () => {
    expect(parseComposerInput("/model", { discovered: new Map() })).toEqual({ kind: "model" });
  });

  it("/model gpt4 → model with search", () => {
    expect(parseComposerInput("/model gpt4", { discovered: new Map() })).toEqual({
      kind: "model",
      search: "gpt4",
    });
  });

  it("/name → name with no arg", () => {
    expect(parseComposerInput("/name", { discovered: new Map() })).toEqual({ kind: "name" });
  });

  it("/name Foo → name with arg", () => {
    expect(parseComposerInput("/name Foo", { discovered: new Map() })).toEqual({
      kind: "name",
      name: "Foo",
    });
  });

  it("/session → session-info", () => {
    expect(parseComposerInput("/session", { discovered: new Map() })).toEqual({
      kind: "session-info",
    });
  });

  it("/new → new-session", () => {
    expect(parseComposerInput("/new", { discovered: new Map() })).toEqual({
      kind: "new-session",
    });
  });

  it("/compact → compact (no instructions)", () => {
    expect(parseComposerInput("/compact", { discovered: new Map() })).toEqual({
      kind: "compact",
    });
  });

  it("/compact focus on tests → compact with instructions", () => {
    expect(parseComposerInput("/compact focus on tests", { discovered: new Map() })).toEqual({
      kind: "compact",
      customInstructions: "focus on tests",
    });
  });

  it("/export → export (no path)", () => {
    expect(parseComposerInput("/export", { discovered: new Map() })).toEqual({
      kind: "export",
    });
  });

  it("/export ./out.html → export with path", () => {
    expect(parseComposerInput("/export ./out.html", { discovered: new Map() })).toEqual({
      kind: "export",
      outputPath: "./out.html",
    });
  });

  it("/fork → fork", () => {
    expect(parseComposerInput("/fork", { discovered: new Map() })).toEqual({ kind: "fork" });
  });

  it("/clone → clone", () => {
    expect(parseComposerInput("/clone", { discovered: new Map() })).toEqual({ kind: "clone" });
  });

  it("/resume → resume", () => {
    expect(parseComposerInput("/resume", { discovered: new Map() })).toEqual({ kind: "resume" });
  });

  it("/copy → copy", () => {
    expect(parseComposerInput("/copy", { discovered: new Map() })).toEqual({ kind: "copy" });
  });

  it("/quit → quit", () => {
    expect(parseComposerInput("/quit", { discovered: new Map() })).toEqual({ kind: "quit" });
  });

  it("/settings → open-app-settings", () => {
    expect(parseComposerInput("/settings", { discovered: new Map() })).toEqual({
      kind: "open-app-settings",
    });
  });

  it("/diff → git-diff", () => {
    expect(parseComposerInput("/diff", { discovered: new Map() })).toEqual({
      kind: "git-diff",
    });
  });
});

describe("parseComposerInput — arg-less built-ins with trailing text fall through", () => {
  it("/session extra → send-prompt (TUI parity)", () => {
    expect(parseComposerInput("/session extra", { discovered: new Map() })).toEqual({
      kind: "send-prompt",
      text: "/session extra",
    });
  });

  it("/new anything → send-prompt", () => {
    expect(parseComposerInput("/new anything", { discovered: new Map() })).toEqual({
      kind: "send-prompt",
      text: "/new anything",
    });
  });

  it("/copy trailing → send-prompt", () => {
    expect(parseComposerInput("/copy trailing", { discovered: new Map() })).toEqual({
      kind: "send-prompt",
      text: "/copy trailing",
    });
  });

  it("/diff anything → send-prompt (arg-less)", () => {
    expect(parseComposerInput("/diff anything", { discovered: new Map() })).toEqual({
      kind: "send-prompt",
      text: "/diff anything",
    });
  });
});

describe("parseComposerInput — unsupported TUI commands", () => {
  it.each([
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
  ])("/%s → unsupported", (name) => {
    expect(parseComposerInput(`/${name}`, { discovered: new Map() })).toEqual({
      kind: "unsupported",
      name,
    });
  });
});

describe("parseComposerInput — discovered (extension/prompt/skill)", () => {
  it("extension command → send-prompt with commandSource", () => {
    const action = parseComposerInput("/myext do thing", {
      discovered: disc([["myext", "extension"]]),
    });
    expect(action).toEqual({
      kind: "send-prompt",
      text: "/myext do thing",
      commandSource: "extension",
    });
  });

  it("skill command → send-prompt with commandSource: 'skill'", () => {
    const action = parseComposerInput("/skill:brave-search", {
      discovered: disc([["skill:brave-search", "skill"]]),
    });
    expect(action).toEqual({
      kind: "send-prompt",
      text: "/skill:brave-search",
      commandSource: "skill",
    });
  });

  it("prompt template → send-prompt with commandSource: 'prompt'", () => {
    const action = parseComposerInput("/fix-tests", {
      discovered: disc([["fix-tests", "prompt"]]),
    });
    expect(action).toEqual({
      kind: "send-prompt",
      text: "/fix-tests",
      commandSource: "prompt",
    });
  });

  it("discovered shadows a built-in (e.g. extension named 'session')", () => {
    const action = parseComposerInput("/session", {
      discovered: disc([["session", "extension"]]),
    });
    expect(action).toEqual({
      kind: "send-prompt",
      text: "/session",
      commandSource: "extension",
    });
  });

  it("discovered shadows an unsupported command (extension named 'login')", () => {
    const action = parseComposerInput("/login", {
      discovered: disc([["login", "extension"]]),
    });
    expect(action).toEqual({
      kind: "send-prompt",
      text: "/login",
      commandSource: "extension",
    });
  });

  it("unknown /foo → send-prompt (TUI fall-through)", () => {
    expect(parseComposerInput("/foo bar", { discovered: new Map() })).toEqual({
      kind: "send-prompt",
      text: "/foo bar",
    });
  });

  it("unknown source string is treated as plain send-prompt", () => {
    const action = parseComposerInput("/weird", {
      discovered: new Map([["weird", { name: "weird", source: "future-type" }]]),
    });
    expect(action).toEqual({ kind: "send-prompt", text: "/weird" });
  });
});

describe("parseComposerInput — slash with no name", () => {
  it("/ with no space and no name → send-prompt", () => {
    expect(parseComposerInput("/", { discovered: new Map() })).toEqual({
      kind: "send-prompt",
      text: "/",
    });
  });
});
