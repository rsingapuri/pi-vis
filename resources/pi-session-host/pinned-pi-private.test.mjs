import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { VERSION as INSTALLED_PI_VERSION } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { PINNED_PRIVATE_LLAMA_VERSION, importPinnedLlamaExtension } from "./pinned-pi-private.mjs";

const PINNED_PI_CLI = fileURLToPath(
  new URL("../../node_modules/@earendil-works/pi-coding-agent/dist/cli.js", import.meta.url),
);

describe("pinned private llama.cpp adapter", () => {
  let tempRoot;

  afterEach(() => {
    if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = undefined;
  });

  it("selects exactly the hidden llama.cpp factory from the installed pinned Pi", async () => {
    expect(INSTALLED_PI_VERSION).toBe(PINNED_PRIVATE_LLAMA_VERSION);
    const extension = await importPinnedLlamaExtension(PINNED_PI_CLI, INSTALLED_PI_VERSION);

    expect(extension).toEqual({
      name: "llama.cpp",
      factory: expect.any(Function),
      hidden: true,
    });
    expect(Object.isFrozen(extension)).toBe(true);
  });

  it("refuses to reuse the exception for a different Pi version", async () => {
    await expect(importPinnedLlamaExtension(PINNED_PI_CLI, "0.84.2")).rejects.toThrow(
      /approved only for Pi 0\.85\.1/,
    );
  });

  it("fails closed when the private built-in registry changes shape", async () => {
    tempRoot = realpathSync(mkdtempSync(path.join(os.tmpdir(), "pivis-private-pi-")));
    const packageDir = path.join(tempRoot, "node_modules", "@earendil-works", "pi-coding-agent");
    const distDir = path.join(packageDir, "dist");
    mkdirSync(path.join(distDir, "extensions"), { recursive: true });
    writeFileSync(path.join(packageDir, "package.json"), JSON.stringify({ type: "module" }));
    writeFileSync(path.join(distDir, "cli.js"), "// fake pinned Pi CLI\n");
    writeFileSync(path.join(distDir, "index.js"), "export const VERSION = '0.85.1';\n");
    writeFileSync(
      path.join(distDir, "extensions", "index.js"),
      "export const builtInExtensions = [];\n",
    );

    await expect(
      importPinnedLlamaExtension(path.join(distDir, "cli.js"), PINNED_PRIVATE_LLAMA_VERSION),
    ).rejects.toThrow(/exactly one llama\.cpp extension/);
  });
});
