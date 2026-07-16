import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { reconcileRestoration } from "./restoration-reconciler.js";

async function sessionFile(lines: string[]): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pivis-restoration-"));
  const file = path.join(dir, "session.jsonl");
  await writeFile(file, `${lines.join("\n")}\n`);
  return file;
}

const user = (content: unknown) =>
  JSON.stringify({ id: "1", type: "message", message: { role: "user", content } });

describe("reconcileRestoration", () => {
  it("drops only a matching user message appended after the dispatch offset", async () => {
    const prefix = `${user("same text")}\n`;
    const file = await sessionFile([prefix.trim(), user("same text")]);
    expect(await reconcileRestoration(file, Buffer.byteLength(prefix), ["same  text"])).toBe(
      "dropped",
    );
  });

  it("restores for no match, duplicate text before the offset, and corrupt appended JSONL", async () => {
    const prefix = `${user("duplicate")}\n`;
    const absent = await sessionFile([prefix.trim(), user("other")]);
    expect(await reconcileRestoration(absent, Buffer.byteLength(prefix), ["duplicate"])).toBe(
      "restore",
    );
    const corrupt = await sessionFile([prefix.trim(), "{not json"]);
    expect(await reconcileRestoration(corrupt, Buffer.byteLength(prefix), ["duplicate"])).toBe(
      "restore",
    );
  });

  it("extracts text content arrays and biases to restore without a readable file", async () => {
    const file = await sessionFile([user([{ type: "text", text: "array content" }])]);
    expect(await reconcileRestoration(file, 0, ["array content"])).toBe("dropped");
    expect(await reconcileRestoration("/definitely/missing.jsonl", 0, ["text"])).toBe("restore");
  });
});
