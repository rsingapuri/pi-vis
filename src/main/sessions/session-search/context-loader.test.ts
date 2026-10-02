import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ContextLoader,
  type ResolvedContextTarget,
  validateExactTarget,
} from "./context-loader.js";
import { SessionCatalog } from "./session-catalog.js";

const directories: string[] = [];
const hash = (text: string) => createHash("sha256").update(text).digest("hex");

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

async function corpus(rows: object[]) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "context-loader-"));
  directories.push(root);
  const folder = path.join(root, "sessions");
  await fs.mkdir(folder);
  const workspace = "/workspace/a";
  const file = path.join(folder, "session.jsonl");
  const serializedRows = [
    JSON.stringify({ type: "session", version: 3, id: "session", timestamp: 1, cwd: workspace }),
    ...rows.map((row) => JSON.stringify(row)),
  ];
  await fs.writeFile(file, `${serializedRows.join("\n")}\n`);
  let workspaces = [workspace];
  const catalog = new SessionCatalog({
    sessionsRoot: root,
    getSettings: () => ({ workspaceOrder: workspaces }),
  });
  const [source] = await catalog.refresh();
  if (!source) throw new Error("fixture source missing");
  const target = (
    entryId: string,
    part: string,
    text: string,
    occurrence = 0,
  ): ResolvedContextTarget => ({
    canonicalPath: source.canonicalPath,
    workspacePath: workspace,
    sourceRevision: source.sourceRevision,
    headerSessionId: source.sessionId,
    entryOrdinal: rows.findIndex((row) => "id" in row && row.id === entryId) + 2,
    byteStart: Buffer.byteLength(
      `${serializedRows
        .slice(0, rows.findIndex((row) => "id" in row && row.id === entryId) + 1)
        .join("\n")}\n`,
    ),
    byteEnd: Buffer.byteLength(
      serializedRows
        .slice(0, rows.findIndex((row) => "id" in row && row.id === entryId) + 2)
        .join("\n"),
    ),
    entryId,
    contentPartKey: part,
    occurrence,
    digest: hash(text),
    matchText: text,
  });
  return {
    file,
    catalog,
    source,
    target,
    removeWorkspace: () => {
      workspaces = [];
    },
  };
}

const message = (
  id: string,
  parentId: string | undefined,
  role: "user" | "assistant",
  content: string,
) => ({
  type: "message",
  id,
  ...(parentId ? { parentId } : {}),
  timestamp: 1,
  message: { role, content },
});

describe("ContextLoader", () => {
  it("centers the exact repeated occurrence with bounded pre-compaction ancestry", async () => {
    const fixture = await corpus([
      message("one", undefined, "user", "before compaction"),
      {
        type: "compaction",
        id: "compact",
        parentId: "one",
        summary: "summary",
        firstKeptEntryId: "one",
        tokensBefore: 500,
      },
      message("two", "compact", "assistant", "repeat phrase and repeat phrase"),
      message("three", "two", "assistant", "following"),
    ]);
    const result = await new ContextLoader(fixture.catalog).load(
      {
        ...fixture.target("two", "text", "repeat phrase and repeat phrase", 1),
        matchText: "repeat phrase",
      },
      { before: 2, after: 1 },
    );
    expect(result.outcome).toBe("ready");
    if (result.outcome === "ready") {
      const matched = result.items.find((item) => item.target);
      expect(matched?.matchRanges).toEqual([{ start: 18, end: 31 }]);
      expect(result.items.map((item) => item.entryId)).toContain("compact");
      expect(result.items.length).toBeLessThanOrEqual(4);
    }
  });

  it("marks alternate persisted branches and incomplete ancestry without fabricating a chain", async () => {
    const fixture = await corpus([
      message("root", undefined, "user", "root"),
      message("old", "root", "assistant", "old branch"),
      message("new", "root", "assistant", "new branch"),
      message("orphan", "missing", "assistant", "orphan text"),
    ]);
    const loader = new ContextLoader(fixture.catalog);
    const alternate = await loader.load(fixture.target("old", "text", "old branch"));
    expect(alternate.outcome).toBe("ready");
    if (alternate.outcome === "ready") expect(alternate.branchKind).toBe("other-saved-branch");
    const orphan = await loader.load(fixture.target("orphan", "text", "orphan text"));
    expect(orphan.outcome).toBe("ready");
    if (orphan.outcome === "ready") expect(orphan.ancestryIncomplete).toBe(true);
  });

  it("validates exact target bytes even when metadata revision evidence could be unchanged", async () => {
    const fixture = await corpus([message("one", undefined, "user", "needle")]);
    const target = fixture.target("one", "text", "needle");
    expect(await validateExactTarget(fixture.source, target)).toBe(true);

    const original = await fs.readFile(fixture.file, "utf8");
    await fs.writeFile(fixture.file, original.replace("needle", "noodle"));
    expect(await validateExactTarget(fixture.source, target)).toBe(false);
  });

  it("validates the retained descriptor after an atomic pathname replacement", async () => {
    const fixture = await corpus([message("one", undefined, "user", "descriptor needle")]);
    const target = fixture.target("one", "text", "descriptor needle");
    const original = await fs.readFile(fixture.file, "utf8");
    const handle = await fs.open(fixture.file, "r");
    try {
      await fs.rename(fixture.file, `${fixture.file}.pinned`);
      await fs.writeFile(
        fixture.file,
        original
          .replace('"id":"session"', '"id":"changed"')
          .replace("/workspace/a", "/workspace/b"),
      );
      const replacement = await fs.open(fixture.file, "r");
      try {
        // The copied target still has identical offsets and digest, but its
        // descriptor header no longer carries the catalogued authority.
        expect(await validateExactTarget(fixture.source, target, replacement.fd)).toBe(false);
      } finally {
        await replacement.close();
      }
      expect(await validateExactTarget(fixture.source, target, handle.fd)).toBe(true);
    } finally {
      await handle.close();
    }
  });

  it("relocates only an unchanged exact persisted part after append or rewrite", async () => {
    const fixture = await corpus([message("one", undefined, "user", "needle")]);
    const loader = new ContextLoader(fixture.catalog);
    const target = fixture.target("one", "text", "needle");
    await fs.appendFile(
      fixture.file,
      `${JSON.stringify(message("two", "one", "assistant", "append"))}\n`,
    );
    expect((await loader.load(target)).outcome).toBe("relocated");

    await fs.writeFile(
      fixture.file,
      `${[
        JSON.stringify({
          type: "session",
          version: 3,
          id: "session",
          timestamp: 1,
          cwd: "/workspace/a",
        }),
        JSON.stringify(message("one", undefined, "user", "replaced")),
      ].join("\n")}\n`,
    );
    expect((await loader.load(target)).outcome).toBe("changed");
  });

  it("bounds total context bytes even when neighboring persisted parts are large", async () => {
    const rows = [];
    let parentId: string | undefined;
    for (let index = 0; index < 8; index++) {
      const id = `large-${index}`;
      rows.push(message(id, parentId, "assistant", `${index}-${"x".repeat(60 * 1024)}`));
      parentId = id;
    }
    rows.push(message("target", parentId, "user", "bounded context needle"));
    const fixture = await corpus(rows);
    const result = await new ContextLoader(fixture.catalog).load(
      fixture.target("target", "text", "bounded context needle"),
      { before: 20, after: 20 },
    );
    expect(result.outcome).toBe("ready");
    if (result.outcome === "ready") {
      expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThan(270 * 1024);
      expect(result.items.some((item) => item.target)).toBe(true);
      expect(result.hasEarlier).toBe(true);
    }
  });

  it("yields long context scans so successor worker queries can run", async () => {
    const rows = [];
    let parentId: string | undefined;
    for (let index = 0; index < 501; index++) {
      const id = `entry-${index}`;
      rows.push(message(id, parentId, "assistant", `context row ${index}`));
      parentId = id;
    }
    const fixture = await corpus(rows);
    const yieldToPriority = vi.fn(async () => undefined);
    const result = await new ContextLoader(
      fixture.catalog,
      { graphEntries: 1_000, graphMetadataBytes: 2 * 1024 * 1024 },
      yieldToPriority,
    ).load(fixture.target("entry-500", "text", "context row 500"));

    expect(result.outcome).toBe("ready");
    expect(yieldToPriority).toHaveBeenCalled();
  });

  it("returns an honest unavailable outcome when graph work exceeds its cap", async () => {
    const fixture = await corpus([
      message("one", undefined, "user", "one"),
      message("two", "one", "assistant", "two"),
      message("three", "two", "assistant", "bounded graph target"),
    ]);
    const result = await new ContextLoader(fixture.catalog, {
      graphEntries: 2,
      graphMetadataBytes: 1024,
    }).load(fixture.target("three", "text", "bounded graph target"));

    expect(result).toEqual({
      outcome: "unavailable",
      message: "This saved session is too large to preview safely.",
    });
  });

  it("reports removal and workspace removal without reading unrelated authority", async () => {
    const fixture = await corpus([message("one", undefined, "user", "needle")]);
    const loader = new ContextLoader(fixture.catalog);
    const target = fixture.target("one", "text", "needle");
    fixture.removeWorkspace();
    expect((await loader.load(target)).outcome).toBe("forbidden");
    // Restore a separate source then delete it: revalidation must not fall back to a path supplied by content.
    await fs.rm(fixture.file);
    expect((await loader.load({ ...target, workspacePath: "/workspace/a" })).outcome).toBe(
      "removed",
    );
  });

  it("has no registry or host dependency", async () => {
    const source = await fs.readFile(new URL("./context-loader.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(
      /from\s+["'][^"']*(session-registry|SessionRegistry|host)[^"']*["']/,
    );
  });
});
