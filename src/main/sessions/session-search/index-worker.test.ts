import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SESSION_SEARCH_SCHEMA_VERSION } from "./index-schema.js";
import { sessionSearchWorkerTesting } from "./index-worker.js";
import type { SearchWorkerSource } from "./worker-protocol.js";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as {
  DatabaseSync: typeof import("node:sqlite").DatabaseSync;
};
const roots: string[] = [];

afterEach(() => {
  sessionSearchWorkerTesting.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function source(file: string, workspacePath: string, archived = false): SearchWorkerSource {
  const stat = fs.statSync(file);
  return {
    canonicalPath: file,
    sessionsRoot: path.dirname(path.dirname(file)),
    sessionId: path.basename(file, ".jsonl"),
    workspacePath,
    archived,
    sessionName: "Old lifecycle investigation",
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    device: stat.dev,
    inode: stat.ino,
    prefixFingerprint: createHash("sha256")
      .update(fs.readFileSync(file).subarray(0, 4096))
      .digest("hex"),
    sourceRevision: `${stat.size}:${stat.mtimeMs}:${stat.dev}:${stat.ino}`,
  };
}

function line(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

describe("session search index worker engine", () => {
  it("prioritizes exact opens and dirty-source promotion over full indexing", () => {
    expect(sessionSearchWorkerTesting.isPriorityRequest({ type: "validate" } as never)).toBe(true);
    expect(
      sessionSearchWorkerTesting.isPriorityRequest({
        type: "reconcile",
        completeCatalog: false,
      } as never),
    ).toBe(true);
    expect(
      sessionSearchWorkerTesting.isPriorityRequest({
        type: "reconcile",
        completeCatalog: true,
      } as never),
    ).toBe(false);
  });

  it("advances the query snapshot revision after every committed indexing chunk", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pivis-search-worker-revision-"));
    roots.push(root);
    const workspace = path.join(root, "workspace");
    const sessions = path.join(root, "sessions", "bucket");
    const file = path.join(sessions, "progressive.jsonl");
    fs.mkdirSync(workspace, { recursive: true });
    fs.mkdirSync(sessions, { recursive: true });
    const rows = [
      line({ type: "session", version: 3, id: "progressive", timestamp: 1, cwd: workspace }),
    ];
    for (let index = 0; index < 1_100; index++) {
      rows.push(
        line({
          type: "message",
          id: `entry-${index}`,
          timestamp: index + 2,
          message: {
            role: "user",
            content: `${index >= 500 ? "progressive needle ".repeat(6) : "progressive needle"} ${index}`,
          },
        }),
      );
    }
    fs.writeFileSync(file, rows.join(""));
    await sessionSearchWorkerTesting.initialize(path.join(root, "index"));
    const snapshots: Array<{ revision: number; topEntryId: string | undefined }> = [];
    sessionSearchWorkerTesting.setAfterChunkCommit((revision) => {
      const result = sessionSearchWorkerTesting.runQuery(
        workspace,
        "progressive needle",
        0,
        20,
        [],
        [file],
        [file],
      );
      snapshots.push({ revision, topEntryId: result.matches[0]?.entryId });
    });

    await sessionSearchWorkerTesting.reconcile([source(file, workspace)]);

    expect(snapshots.length).toBeGreaterThanOrEqual(2);
    for (let index = 1; index < snapshots.length; index++) {
      expect(snapshots[index]!.revision).toBeGreaterThan(snapshots[index - 1]!.revision);
      expect(snapshots[index]!.topEntryId).not.toBe(snapshots[index - 1]!.topEntryId);
    }
    expect(sessionSearchWorkerTesting.currentRevision()).toBeGreaterThan(
      snapshots.at(-1)!.revision,
    );
  });

  it("does not let resumed bulk work overwrite a newer priority source descriptor", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pivis-search-worker-supersession-"));
    roots.push(root);
    const workspace = path.join(root, "workspace");
    const sessions = path.join(root, "sessions", "bucket");
    const bulkFile = path.join(sessions, "bulk.jsonl");
    const targetFile = path.join(sessions, "target.jsonl");
    fs.mkdirSync(workspace, { recursive: true });
    fs.mkdirSync(sessions, { recursive: true });
    const bulkRows = [
      line({ type: "session", version: 3, id: "bulk", timestamp: 1, cwd: workspace }),
    ];
    for (let index = 0; index < 600; index++) {
      bulkRows.push(
        line({
          type: "message",
          id: `bulk-${index}`,
          timestamp: index + 2,
          message: { role: "user", content: `bulk filler ${index}` },
        }),
      );
    }
    fs.writeFileSync(bulkFile, bulkRows.join(""));
    fs.writeFileSync(
      targetFile,
      line({ type: "session", version: 3, id: "target", timestamp: 1, cwd: workspace }) +
        line({
          type: "message",
          id: "target-old",
          timestamp: 2,
          message: { role: "user", content: "old target content" },
        }),
    );
    const staleTarget = source(targetFile, workspace);
    await sessionSearchWorkerTesting.initialize(path.join(root, "index"));
    let promotedTarget: SearchWorkerSource | null = null;
    sessionSearchWorkerTesting.setAfterChunkCommit(async () => {
      sessionSearchWorkerTesting.setAfterChunkCommit(null);
      fs.appendFileSync(
        targetFile,
        line({
          type: "message",
          id: "target-new",
          timestamp: 3,
          message: { role: "user", content: "priority fresh descriptor" },
        }),
      );
      promotedTarget = source(targetFile, workspace);
      await sessionSearchWorkerTesting.reconcile([promotedTarget], false);
    });

    await sessionSearchWorkerTesting.reconcile([source(bulkFile, workspace), staleTarget], true);

    expect(promotedTarget).not.toBeNull();
    const result = sessionSearchWorkerTesting.runQuery(
      workspace,
      "priority fresh descriptor",
      0,
      20,
      [],
      [targetFile],
      [targetFile],
    );
    expect(result.matches[0]).toMatchObject({
      entryId: "target-new",
      sourceRevision: promotedTarget!.sourceRevision,
    });
  });

  it("rolls back visible indexing mutations when the atomic revision write fails", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pivis-search-worker-atomic-revision-"));
    roots.push(root);
    const workspace = path.join(root, "workspace");
    const sessions = path.join(root, "sessions", "bucket");
    const file = path.join(sessions, "atomic.jsonl");
    const databaseDirectory = path.join(root, "index");
    fs.mkdirSync(workspace, { recursive: true });
    fs.mkdirSync(sessions, { recursive: true });
    fs.writeFileSync(
      file,
      line({ type: "session", version: 3, id: "atomic", timestamp: 1, cwd: workspace }) +
        line({
          type: "message",
          id: "entry",
          timestamp: 2,
          message: { role: "user", content: "atomic revision evidence" },
        }),
    );
    await sessionSearchWorkerTesting.initialize(databaseDirectory);
    const databasePath = path.join(databaseDirectory, "index.sqlite");
    const setup = new DatabaseSync(databasePath);
    setup.exec(`CREATE TRIGGER reject_revision_insert
      BEFORE INSERT ON metadata
      WHEN NEW.key = 'revision'
      BEGIN SELECT RAISE(ABORT, 'revision write rejected'); END;
      CREATE TRIGGER reject_revision_update
      BEFORE UPDATE OF value ON metadata
      WHEN OLD.key = 'revision'
      BEGIN SELECT RAISE(ABORT, 'revision write rejected'); END`);
    setup.close();
    expect(sessionSearchWorkerTesting.coverage()).toEqual({
      indexedSources: 0,
      totalSources: 0,
      skippedSources: 0,
    });

    await sessionSearchWorkerTesting.reconcile([source(file, workspace)]);

    const inspect = new DatabaseSync(databasePath, { readOnly: true });
    const count = inspect.prepare("SELECT count(*) AS value FROM sources").get() as {
      value: number;
    };
    const persisted = inspect.prepare("SELECT value FROM metadata WHERE key = 'revision'").get() as
      | { value: string }
      | undefined;
    inspect.close();
    expect(count.value).toBe(0);
    expect(Number(persisted?.value ?? 0)).toBe(sessionSearchWorkerTesting.currentRevision());
  });

  it("indexes all branches, visible fields, prefixes and fresh complete appends", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pivis-search-worker-"));
    roots.push(root);
    const workspace = path.join(root, "workspace");
    const sessions = path.join(root, "sessions", "bucket");
    fs.mkdirSync(workspace, { recursive: true });
    fs.mkdirSync(sessions, { recursive: true });
    const file = path.join(sessions, "session-a.jsonl");
    fs.writeFileSync(
      file,
      line({ type: "session", version: 3, id: "session-a", timestamp: 1, cwd: workspace }) +
        line({
          type: "message",
          id: "u1",
          timestamp: 10,
          message: {
            role: "user",
            content: [
              {
                type: "text",
                text: "Exact lifecycle phrase; lifecycle phrase; lifecycle phrase; lifecycle phrase",
              },
            ],
          },
        }) +
        line({
          type: "message",
          id: "a1",
          parentId: "u1",
          timestamp: 11,
          message: {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "hidden private thought" },
              { type: "text", text: "Inspect sessionRegistryPath now" },
            ],
          },
        }) +
        line({
          type: "message",
          id: "other",
          parentId: "u1",
          timestamp: 12,
          message: { role: "user", content: "alternate branch only" },
        }) +
        line({
          type: "message",
          id: "bounded-repeat",
          parentId: "other",
          timestamp: 12.5,
          message: { role: "user", content: "repeatneedle ".repeat(4_000) },
        }),
    );

    await sessionSearchWorkerTesting.initialize(path.join(root, "index"));
    await sessionSearchWorkerTesting.reconcile([source(file, workspace)]);

    const phrase = sessionSearchWorkerTesting.runQuery(workspace, '"lifecycle phrase"', 0, 20, []);
    expect(phrase.matches[0]).toMatchObject({ entryId: "u1", latestPersistedPath: true });
    expect(phrase.matches[0]?.snippet).toContain("lifecycle phrase");
    expect(phrase.matches[0]?.matchRanges.length).toBeGreaterThan(0);
    expect(phrase.matches).toHaveLength(1);
    expect(phrase.matches[0]?.additionalMatches).toBe(3);
    const expanded = sessionSearchWorkerTesting.runQuery(
      workspace,
      '"lifecycle phrase"',
      0,
      20,
      [],
      [file],
    );
    expect(expanded.matches).toHaveLength(1);
    expect(expanded.matches[0]?.additionalMatches).toBe(3);
    const multiTerm = sessionSearchWorkerTesting.runQuery(workspace, "exact phrase", 0, 20, []);
    expect(multiTerm.matches.filter((match) => match.entryId === "u1")).toHaveLength(1);
    expect(
      sessionSearchWorkerTesting.runQuery(workspace, "exact lifecyle", 0, 20, []).matches[0],
    ).toMatchObject({ entryId: "u1", closeMatchTerm: "lifecyle" });

    const bounded = sessionSearchWorkerTesting.runQuery(
      workspace,
      "repeatneedle",
      0,
      200,
      [],
      [file],
    );
    expect(bounded.matches).toHaveLength(1);
    expect(bounded.matches[0]?.additionalMatches).toBe(3_999);
    expect(bounded.truncated).toBe(true);

    expect(
      sessionSearchWorkerTesting.runQuery(workspace, "session reg", 0, 20, []).matches[0],
    ).toMatchObject({ entryId: "a1" });
    expect(
      sessionSearchWorkerTesting.runQuery(workspace, "private thought", 0, 20, []).matches,
    ).toHaveLength(0);
    expect(
      sessionSearchWorkerTesting.runQuery(workspace, "alternate", 0, 20, []).matches[0],
    ).toMatchObject({ entryId: "other", latestPersistedPath: true });
    expect(
      sessionSearchWorkerTesting.runQuery(workspace, "alternate", 0, 20, [], [], []).matches,
    ).toHaveLength(0);

    fs.appendFileSync(
      file,
      line({
        type: "message",
        id: "fresh",
        parentId: "other",
        timestamp: 13,
        message: { role: "assistant", content: "newly appended searchable" },
      }),
    );
    await sessionSearchWorkerTesting.reconcile([source(file, workspace)]);
    expect(
      sessionSearchWorkerTesting.runQuery(workspace, "newly appended", 0, 20, []).matches[0],
    ).toMatchObject({ entryId: "fresh" });

    const partial = JSON.stringify({
      type: "message",
      id: "partial",
      parentId: "fresh",
      timestamp: 14,
      message: { role: "user", content: "completed partial row" },
    });
    fs.appendFileSync(file, partial.slice(0, -1));
    await sessionSearchWorkerTesting.reconcile([source(file, workspace)]);
    expect(
      sessionSearchWorkerTesting.runQuery(workspace, "completed partial", 0, 20, []).matches,
    ).toHaveLength(0);
    fs.appendFileSync(file, `${partial.slice(-1)}\n`);
    await sessionSearchWorkerTesting.reconcile([source(file, workspace)]);
    expect(
      sessionSearchWorkerTesting.runQuery(workspace, "completed partial", 0, 20, []).matches[0],
    ).toMatchObject({ entryId: "partial" });

    fs.writeFileSync(
      file,
      line({ type: "session", version: 3, id: "session-a", timestamp: 1, cwd: workspace }) +
        line({
          type: "message",
          id: "replacement",
          timestamp: 15,
          message: { role: "user", content: "replacement generation" },
        }),
    );
    await sessionSearchWorkerTesting.reconcile([source(file, workspace)]);
    expect(
      sessionSearchWorkerTesting.runQuery(workspace, "newly appended", 0, 20, []).matches,
    ).toHaveLength(0);
    expect(
      sessionSearchWorkerTesting.runQuery(workspace, "replacement generation", 0, 20, [])
        .matches[0],
    ).toMatchObject({ entryId: "replacement" });
  });

  it("repairs deletion and rename through authoritative reconciliation", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pivis-search-worker-"));
    roots.push(root);
    const workspace = path.join(root, "workspace");
    const sessions = path.join(root, "sessions", "bucket");
    fs.mkdirSync(workspace, { recursive: true });
    fs.mkdirSync(sessions, { recursive: true });
    const file = path.join(sessions, "before.jsonl");
    fs.writeFileSync(
      file,
      line({ type: "session", version: 3, id: "moving", cwd: workspace }) +
        line({ type: "message", id: "u1", message: { role: "user", content: "moving needle" } }),
    );
    await sessionSearchWorkerTesting.initialize(path.join(root, "index"));
    await sessionSearchWorkerTesting.reconcile([source(file, workspace)]);
    expect(
      sessionSearchWorkerTesting.runQuery(workspace, "moving needle", 0, 20, []).matches,
    ).toHaveLength(1);

    const renamed = path.join(sessions, "after.jsonl");
    fs.renameSync(file, renamed);
    await sessionSearchWorkerTesting.reconcile([source(renamed, workspace)]);
    expect(
      sessionSearchWorkerTesting.runQuery(workspace, "moving needle", 0, 20, []).matches,
    ).toHaveLength(1);
    fs.rmSync(renamed);
    await sessionSearchWorkerTesting.reconcile([]);
    expect(
      sessionSearchWorkerTesting.runQuery(workspace, "moving needle", 0, 20, []).matches,
    ).toHaveLength(0);
  });

  it("reports partial coverage for invalid entries and duplicate persisted ids", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pivis-search-worker-"));
    roots.push(root);
    const workspace = path.join(root, "workspace");
    const sessions = path.join(root, "sessions", "bucket");
    fs.mkdirSync(workspace, { recursive: true });
    fs.mkdirSync(sessions, { recursive: true });
    const file = path.join(sessions, "partial.jsonl");
    fs.writeFileSync(
      file,
      [
        line({ type: "session", version: 3, id: "partial", cwd: workspace }),
        "{ malformed row }\n",
        line({ type: "message", id: "same", message: { role: "user", content: "first wins" } }),
        line({ type: "message", id: "same", message: { role: "user", content: "second omitted" } }),
      ].join(""),
    );
    await sessionSearchWorkerTesting.initialize(path.join(root, "index"));
    await sessionSearchWorkerTesting.reconcile([source(file, workspace)]);

    expect(
      sessionSearchWorkerTesting.runQuery(workspace, "first wins", 0, 20, []).matches,
    ).toHaveLength(1);
    expect(
      sessionSearchWorkerTesting.runQuery(workspace, "second omitted", 0, 20, []).matches,
    ).toHaveLength(0);
    expect(sessionSearchWorkerTesting.coverage(workspace)).toEqual({
      indexedSources: 1,
      totalSources: 1,
      skippedSources: 1,
    });
  });

  it("quarantines a corrupt disposable database and rebuilds", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pivis-search-worker-"));
    roots.push(root);
    const index = path.join(root, "index");
    fs.mkdirSync(index);
    fs.writeFileSync(path.join(index, "index.sqlite"), "not a sqlite database");

    await expect(sessionSearchWorkerTesting.initialize(index)).resolves.toBeUndefined();
    expect(fs.readdirSync(index).some((name) => name.includes(".corrupt-"))).toBe(true);
  });

  it("rebuilds older schemas and preserves a newer downgrade index aside", async () => {
    for (const version of [SESSION_SEARCH_SCHEMA_VERSION - 1, SESSION_SEARCH_SCHEMA_VERSION + 1]) {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "pivis-search-worker-schema-"));
      roots.push(root);
      const index = path.join(root, "index");
      fs.mkdirSync(index);
      const db = new DatabaseSync(path.join(index, "index.sqlite"));
      db.exec(`PRAGMA user_version = ${version}`);
      db.close();

      await sessionSearchWorkerTesting.initialize(index);
      expect(fs.readdirSync(index).some((name) => name.includes(".schema-"))).toBe(true);
    }
  });

  it("excludes archived sources", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pivis-search-worker-"));
    roots.push(root);
    const workspace = path.join(root, "workspace");
    const sessions = path.join(root, "sessions", "bucket");
    fs.mkdirSync(workspace, { recursive: true });
    fs.mkdirSync(sessions, { recursive: true });
    const file = path.join(sessions, "archived.jsonl");
    fs.writeFileSync(
      file,
      line({ type: "session", version: 3, id: "archived", timestamp: 1, cwd: workspace }) +
        line({ type: "message", id: "u1", message: { role: "user", content: "secret needle" } }),
    );
    await sessionSearchWorkerTesting.initialize(path.join(root, "index"));
    await sessionSearchWorkerTesting.reconcile([source(file, workspace, true)]);
    expect(
      sessionSearchWorkerTesting.runQuery(workspace, "needle", 0, 20, []).matches,
    ).toHaveLength(0);
  });
});
