import fs from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BUILD_STALE_MESSAGE, assertBuildFreshness } from "../electron-launch.mjs";
import { InvariantContext, createLineBuffer, matchesAllowMatcher } from "./invariants.mjs";

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("E2E invariant helpers", () => {
  it("line-buffers split stderr diagnostics", () => {
    const lines: string[] = [];
    const buffer = createLineBuffer((line) => lines.push(line));
    buffer.push("Error occurred in event hand");
    buffer.push("ler\r\nnext");
    buffer.end();
    expect(lines).toEqual(["Error occurred in event handler", "next"]);
  });

  it("substring-matches strings, anchors via RegExp, and requires a matcher", () => {
    expect(matchesAllowMatcher("expected error", "expected error")).toBe(true);
    // Diagnostics arrive wrapped (handler prefixes, toast suffixes); a string
    // matcher tolerates that wrapping instead of silently never matching.
    expect(matchesAllowMatcher("expected error", "prefix expected error suffix")).toBe(true);
    expect(matchesAllowMatcher("expected error", "unrelated diagnostic")).toBe(false);
    expect(matchesAllowMatcher(/^expected error$/, "expected error")).toBe(true);
    expect(matchesAllowMatcher(/^expected error$/, "prefix expected error")).toBe(false);
    expect(() => new InvariantContext().allow("main-stderr", undefined as never)).toThrow(
      "requires a nonempty substring string or RegExp",
    );
  });

  it("requires all build outputs to be at least as fresh as recursive sources", () => {
    const root = fs.mkdtempSync(join(os.tmpdir(), "pivis-freshness-"));
    temporaryDirectories.push(root);
    const source = join(root, "src");
    const host = join(root, "resources/pi-session-host");
    const copied = join(root, "out/resources/pi-session-host");
    const main = join(root, "out/main/index.js");
    for (const file of [
      join(source, "nested/input.ts"),
      join(host, "nested/host.mjs"),
      join(copied, "host.mjs"),
      join(copied, "nested/host.mjs"),
      main,
    ]) {
      fs.mkdirSync(join(file, ".."), { recursive: true });
      fs.writeFileSync(file, "x");
    }
    const old = new Date(Date.now() - 10_000);
    const fresh = new Date(Date.now() + 10_000);
    for (const file of [join(source, "nested/input.ts"), join(host, "nested/host.mjs")]) {
      fs.utimesSync(file, old, old);
    }
    for (const file of [main, join(copied, "host.mjs"), join(copied, "nested/host.mjs")]) {
      fs.utimesSync(file, fresh, fresh);
    }
    const paths = {
      sourceDirectories: [source, host],
      mainBundle: main,
      copiedHostDirectory: copied,
    };
    expect(() => assertBuildFreshness(false, paths)).not.toThrow();

    fs.utimesSync(join(source, "nested/input.ts"), fresh, new Date(Date.now() + 20_000));
    expect(() => assertBuildFreshness(false, paths)).toThrow(BUILD_STALE_MESSAGE);
    expect(() => assertBuildFreshness(true, paths)).not.toThrow();
  });
});
