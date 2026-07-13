import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { setImmediate as yieldImmediate } from "node:timers/promises";
import { parentPort } from "node:worker_threads";
import { SessionEntrySchema } from "@shared/session-file/entries.js";
import type { SessionSearchRole } from "@shared/session-search.js";
import { loadContextFromValidatedSource, validateExactTarget } from "./context-loader.js";
import {
  MAX_SESSION_SEARCH_SEGMENT_BYTES,
  extractSearchSegments,
  openConfinedRegularFile,
  streamJsonlRows,
} from "./entry-extractor.js";
import { SESSION_SEARCH_SCHEMA_SQL, SESSION_SEARCH_SCHEMA_VERSION } from "./index-schema.js";
import { parseSearchQuery } from "./query-parser.js";
import { findTypoAlternatives, rankSearchCandidates } from "./ranking.js";
import { createSnippet, findOriginalMatchRangesBounded } from "./snippet.js";
import type {
  SearchWorkerMatch,
  SearchWorkerRequest,
  SearchWorkerResponse,
  SearchWorkerSource,
} from "./worker-protocol.js";

const require = createRequire(import.meta.url);

const MAX_CANDIDATES = 1_000;
const MAX_DICTIONARY_TERMS = 8_000;
const INDEX_TRANSACTION_ROWS = 500;
const INDEX_TRANSACTION_BYTES = 4 * 1024 * 1024;
const MAX_RESULT_OCCURRENCES_PER_SEGMENT = 128;

type SqliteModule = typeof import("node:sqlite");

interface CandidateRow {
  segment_id: number;
  source_key: number;
  canonical_path: string;
  source_revision: string;
  workspace_path: string;
  session_id: string;
  session_name: string;
  worktree_name: string | null;
  entry_ordinal: number;
  byte_start: number;
  byte_end: number;
  entry_id: string;
  content_part_key: string;
  role: SessionSearchRole;
  timestamp_ms: number | null;
  original_text: string;
  normalized_text: string;
  derived_text: string;
  content_digest: string;
  latest_persisted_path: number;
}

interface QueueItem {
  request: SearchWorkerRequest;
}

let database: DatabaseSync | null = null;
let databasePath: string | null = null;
let revision = 0;
let coverage = { indexedSources: 0, totalSources: 0, skippedSources: 0 };
let shuttingDown = false;
const priorityQueue: QueueItem[] = [];
const backgroundQueue: QueueItem[] = [];
let pumping = false;
let testingAfterChunkCommit: ((revision: number) => Promise<void> | void) | null = null;
let reconcileGeneration = 0;
const latestSourceGeneration = new Map<string, number>();

function isPriorityRequest(request: SearchWorkerRequest): boolean {
  return (
    request.type === "query" ||
    request.type === "context" ||
    request.type === "status" ||
    request.type === "validate" ||
    (request.type === "reconcile" && request.completeCatalog === false)
  );
}

function sourceRevision(source: SearchWorkerSource): string {
  return source.sourceRevision;
}

function metadataNumber(key: string): number {
  if (!database) return 0;
  const row = database.prepare("SELECT value FROM metadata WHERE key = ?").get(key) as
    | { value?: string }
    | undefined;
  const value = Number.parseInt(row?.value ?? "0", 10);
  return Number.isFinite(value) ? value : 0;
}

function setMetadata(key: string, value: string | number): void {
  database
    ?.prepare(
      "INSERT INTO metadata(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    )
    .run(key, String(value));
}

/** Persists the next snapshot in the same transaction as its visible mutation. */
function commitVisibleMutation(db: DatabaseSync): void {
  const committedRevision = revision + 1;
  setMetadata("revision", committedRevision);
  db.exec("COMMIT");
  revision = committedRevision;
}

function databaseCoverage(workspacePath?: string): typeof coverage {
  if (!database) return { indexedSources: 0, totalSources: 0, skippedSources: 0 };
  const where = workspacePath ? "WHERE workspace_path = ? AND archived = 0" : "";
  const statement = database.prepare(
    `SELECT
       count(*) AS total,
       sum(CASE WHEN health IN ('indexed', 'partial') THEN 1 ELSE 0 END) AS indexed,
       sum(CASE WHEN health NOT IN ('indexed', 'indexing') THEN 1 ELSE 0 END) AS skipped
     FROM sources ${where}`,
  );
  const row = (workspacePath ? statement.get(workspacePath) : statement.get()) as {
    total: number;
    indexed: number | null;
    skipped: number | null;
  };
  return {
    indexedSources: Number(row.indexed ?? 0),
    totalSources: Number(row.total ?? 0),
    skippedSources: Number(row.skipped ?? 0),
  };
}

function updateCoverage(): void {
  coverage = databaseCoverage();
}

async function initialize(databaseDirectory: string): Promise<void> {
  if (database && databasePath === path.join(databaseDirectory, "index.sqlite")) return;
  database?.close();
  database = null;
  fs.mkdirSync(databaseDirectory, { recursive: true, mode: 0o700 });
  const directoryStat = fs.lstatSync(databaseDirectory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new Error("Session search index directory is not a private directory");
  }
  fs.chmodSync(databaseDirectory, 0o700);
  const nextPath = path.join(databaseDirectory, "index.sqlite");
  let DatabaseConstructor: SqliteModule["DatabaseSync"];
  try {
    ({ DatabaseSync: DatabaseConstructor } = require("node:sqlite") as SqliteModule);
  } catch {
    throw new Error("Packaged runtime does not provide SQLite FTS5 support");
  }

  for (const name of fs.readdirSync(databaseDirectory)) {
    if (name.startsWith("index.sqlite.build-")) {
      fs.rmSync(path.join(databaseDirectory, name), { recursive: true, force: true });
    }
  }
  const quarantine = (reason: "corrupt" | "schema"): void => {
    if (fs.existsSync(nextPath)) fs.renameSync(nextPath, `${nextPath}.${reason}-${Date.now()}`);
    for (const suffix of ["-wal", "-shm"]) fs.rmSync(`${nextPath}${suffix}`, { force: true });
  };
  const buildFresh = (): DatabaseSync => {
    const buildPath = `${nextPath}.build-${process.pid}-${Date.now()}`;
    let build: DatabaseSync | null = null;
    try {
      build = new DatabaseConstructor(buildPath);
      build.exec(SESSION_SEARCH_SCHEMA_SQL);
      build.exec(`PRAGMA user_version = ${SESSION_SEARCH_SCHEMA_VERSION}`);
      // Ensure the complete schema lives in the main file before atomic rename.
      build.exec("PRAGMA journal_mode = DELETE");
      build.close();
      build = null;
      fs.renameSync(buildPath, nextPath);
      fs.chmodSync(nextPath, 0o600);
      return new DatabaseConstructor(nextPath);
    } catch (error) {
      try {
        build?.close();
      } catch {}
      for (const suffix of ["", "-wal", "-shm"])
        fs.rmSync(`${buildPath}${suffix}`, { force: true });
      throw error;
    }
  };

  let next!: DatabaseSync;
  if (!fs.existsSync(nextPath)) {
    next = buildFresh();
  } else {
    try {
      next = new DatabaseConstructor(nextPath);
      const version = Number(
        (next.prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
      );
      if (version !== SESSION_SEARCH_SCHEMA_VERSION) {
        next.close();
        quarantine("schema");
        next = buildFresh();
      } else {
        const integrity = next.prepare("PRAGMA quick_check").get() as { quick_check?: string };
        if (integrity.quick_check !== "ok") throw new Error("SQLite quick_check failed");
      }
    } catch (error) {
      try {
        next?.close();
      } catch {}
      quarantine("corrupt");
      next = buildFresh();
      if (!next) throw error;
    }
  }
  // Idempotently restore triggers/indexes if an older compatible build omitted one.
  next.exec(SESSION_SEARCH_SCHEMA_SQL);
  next.exec(`PRAGMA user_version = ${SESSION_SEARCH_SCHEMA_VERSION}`);
  // Recursive branch classification and FTS maintenance must spill to disk
  // rather than scaling native SQLite heap with corpus size.
  next.exec("PRAGMA temp_store = FILE");
  next.exec("PRAGMA cache_size = -16384");
  next.exec("PRAGMA mmap_size = 0");
  next.exec("PRAGMA soft_heap_limit = 100663296");
  database = next;
  databasePath = nextPath;
  revision = metadataNumber("revision");
  updateCoverage();
  try {
    fs.chmodSync(nextPath, 0o600);
  } catch {}
}

function requireDatabase(): DatabaseSync {
  if (!database) throw new Error("Session search index is not initialized");
  return database;
}

interface ExistingSource {
  source_key: number;
  session_id: string;
  workspace_path: string;
  size: number;
  device: number | null;
  inode: number | null;
  prefix_fingerprint: string;
  committed_offset: number;
  committed_ordinal: number;
  committed_tail_hash: string;
  source_revision: string;
  health: string;
}

function existingSource(canonicalPath: string): ExistingSource | undefined {
  return requireDatabase()
    .prepare(
      `SELECT source_key, session_id, workspace_path, size, device, inode,
        prefix_fingerprint, committed_offset, committed_ordinal, committed_tail_hash,
        source_revision, health
       FROM sources WHERE canonical_path = ?`,
    )
    .get(canonicalPath) as unknown as ExistingSource | undefined;
}

function updateSourceMetadata(source: SearchWorkerSource): boolean {
  const db = requireDatabase();
  const worktreeName = source.worktreeName ?? null;
  const archived = source.archived ? 1 : 0;
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = db
      .prepare(
        `UPDATE sources SET workspace_path = ?, worktree_name = ?, archived = ?, session_name = ?
         WHERE canonical_path = ?
           AND (workspace_path IS NOT ? OR worktree_name IS NOT ? OR archived IS NOT ?
                OR session_name IS NOT ?)`,
      )
      .run(
        source.workspacePath,
        worktreeName,
        archived,
        source.sessionName,
        source.canonicalPath,
        source.workspacePath,
        worktreeName,
        archived,
        source.sessionName,
      );
    if (Number(result.changes) > 0) {
      commitVisibleMutation(db);
      return true;
    }
    db.exec("COMMIT");
    return false;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function prefixStillMatches(existing: ExistingSource, source: SearchWorkerSource): boolean {
  if (existing.prefix_fingerprint === source.prefixFingerprint) return true;
  if (existing.size <= 0 || existing.size >= 4096) return false;
  let descriptor: number | undefined;
  try {
    descriptor = openConfinedRegularFile(source.canonicalPath, source.sessionsRoot);
    const buffer = Buffer.alloc(existing.size);
    const read = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
    return (
      createHash("sha256").update(buffer.subarray(0, read)).digest("hex") ===
      existing.prefix_fingerprint
    );
  } catch {
    return false;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function committedTailHash(
  file: string,
  committedOffset: number,
  confinementRoot?: string,
): string {
  if (committedOffset <= 0) return "";
  const length = Math.min(4096, committedOffset);
  const start = committedOffset - length;
  let descriptor: number | undefined;
  try {
    descriptor = openConfinedRegularFile(file, confinementRoot);
    const buffer = Buffer.alloc(length);
    const read = fs.readSync(descriptor, buffer, 0, length, start);
    return createHash("sha256").update(buffer.subarray(0, read)).digest("hex");
  } catch {
    return "invalid";
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function canAppend(existing: ExistingSource, source: SearchWorkerSource): boolean {
  return (
    (existing.health === "indexed" || existing.health === "partial") &&
    existing.session_id === source.sessionId &&
    existing.workspace_path === source.workspacePath &&
    source.size > existing.size &&
    existing.committed_offset <= existing.size &&
    committedTailHash(source.canonicalPath, existing.committed_offset, source.sessionsRoot) ===
      existing.committed_tail_hash &&
    (existing.device === null ||
      source.device === undefined ||
      existing.device === source.device) &&
    (existing.inode === null || source.inode === undefined || existing.inode === source.inode) &&
    prefixStillMatches(existing, source)
  );
}

function beginSource(source: SearchWorkerSource, signature: string): number {
  const db = requireDatabase();
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(
      `INSERT INTO sources(
        canonical_path, session_id, workspace_path, worktree_name, archived,
        session_name, size, mtime_ms, device, inode, prefix_fingerprint,
        committed_offset, committed_ordinal, source_generation, health, source_revision
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 1, 'indexing', ?)
      ON CONFLICT(canonical_path) DO UPDATE SET
        session_id=excluded.session_id,
        workspace_path=excluded.workspace_path,
        worktree_name=excluded.worktree_name,
        archived=excluded.archived,
        session_name=excluded.session_name,
        size=excluded.size,
        mtime_ms=excluded.mtime_ms,
        device=excluded.device,
        inode=excluded.inode,
        prefix_fingerprint=excluded.prefix_fingerprint,
        committed_offset=0,
        committed_ordinal=0,
        source_generation=sources.source_generation + 1,
        health='indexing',
        source_revision=excluded.source_revision`,
    ).run(
      source.canonicalPath,
      source.sessionId,
      source.workspacePath,
      source.worktreeName ?? null,
      source.archived ? 1 : 0,
      source.sessionName,
      source.size,
      source.mtimeMs,
      source.device ?? null,
      source.inode ?? null,
      source.prefixFingerprint,
      signature,
    );
    const row = db
      .prepare("SELECT source_key FROM sources WHERE canonical_path = ?")
      .get(source.canonicalPath) as { source_key: number };
    db.prepare("DELETE FROM entries WHERE source_key = ?").run(row.source_key);
    commitVisibleMutation(db);
    return row.source_key;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function beginAppend(
  source: SearchWorkerSource,
  signature: string,
  existing: ExistingSource,
): number {
  const db = requireDatabase();
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(
      `UPDATE sources SET workspace_path = ?, worktree_name = ?, archived = ?,
       session_name = ?, size = ?, mtime_ms = ?, device = ?, inode = ?,
       prefix_fingerprint = ?, source_revision = ?, health = 'indexing'
       WHERE source_key = ?`,
    ).run(
      source.workspacePath,
      source.worktreeName ?? null,
      source.archived ? 1 : 0,
      source.sessionName,
      source.size,
      source.mtimeMs,
      source.device ?? null,
      source.inode ?? null,
      source.prefixFingerprint,
      signature,
      existing.source_key,
    );
    commitVisibleMutation(db);
    return existing.source_key;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

interface PendingEntry {
  ordinal: number;
  id: string;
  parentId: string | null;
  timestamp: number | null;
  byteStart: number;
  byteEnd: number;
  segments: ReturnType<typeof extractSearchSegments>;
}

function commitEntries(
  sourceKey: number,
  entries: PendingEntry[],
  committedOffset: number,
  committedOrdinal: number,
  alreadyPartial: boolean,
): number {
  const db = requireDatabase();
  let skippedSegments = 0;
  const insertEntry = db.prepare(
    `INSERT OR IGNORE INTO entries(source_key, entry_ordinal, entry_id, parent_id,
      timestamp_ms, byte_start, byte_end)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertSegment = db.prepare(
    `INSERT INTO segments(source_key, entry_ordinal, entry_id, content_part_key,
      occurrence, role, timestamp_ms, original_text, normalized_text, derived_text,
      content_digest)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const entry of entries) {
      const inserted = insertEntry.run(
        sourceKey,
        entry.ordinal,
        entry.id,
        entry.parentId,
        entry.timestamp,
        entry.byteStart,
        entry.byteEnd,
      );
      if (inserted.changes === 0) {
        // Duplicate persisted ids are intentionally first-wins, but coverage
        // must disclose that the later row was omitted.
        skippedSegments += Math.max(1, entry.segments.length);
        continue;
      }
      for (const segment of entry.segments) {
        if (Buffer.byteLength(segment.originalText, "utf8") > MAX_SESSION_SEARCH_SEGMENT_BYTES) {
          skippedSegments += 1;
          continue;
        }
        insertSegment.run(
          sourceKey,
          entry.ordinal,
          entry.id,
          segment.contentPartKey,
          segment.occurrence,
          segment.role,
          segment.timestamp,
          segment.originalText,
          segment.normalizedText,
          segment.derivedComponents.join(" "),
          segment.digest,
        );
      }
    }
    db.prepare(
      `UPDATE sources SET committed_offset = ?, committed_ordinal = ?,
       health = CASE WHEN ? THEN 'indexing-partial' ELSE health END
       WHERE source_key = ?`,
    ).run(
      committedOffset,
      committedOrdinal,
      alreadyPartial || skippedSegments > 0 ? 1 : 0,
      sourceKey,
    );
    commitVisibleMutation(db);
    return skippedSegments;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

async function runPriorityRequests(includeContext = true): Promise<void> {
  await yieldImmediate();
  while (priorityQueue.length) {
    const index = priorityQueue.findIndex(
      (item) =>
        includeContext ||
        item.request.type === "query" ||
        item.request.type === "status" ||
        item.request.type === "validate",
    );
    if (index < 0) break;
    const [item] = priorityQueue.splice(index, 1);
    if (!item) break;
    const response = await dispatch(item.request);
    parentPort?.postMessage(response);
  }
}

function recomputeGraphAndCommitSource(
  sourceKey: number,
  sourcePath: string,
  sourceRoot: string,
  committedOffset: number,
  committedOrdinal: number,
  partial: boolean,
  appendBase?: { ordinal: number; entryId: string } | undefined,
  initialLinear = false,
): void {
  const db = requireDatabase();
  const persistedName = db
    .prepare(
      `SELECT original_text FROM segments WHERE source_key = ? AND role = 'session-name'
       ORDER BY entry_ordinal DESC LIMIT 1`,
    )
    .get(sourceKey) as { original_text?: string } | undefined;
  db.exec("BEGIN IMMEDIATE");
  try {
    if (persistedName?.original_text) {
      db.prepare("UPDATE sources SET session_name = ? WHERE source_key = ?").run(
        persistedName.original_text,
        sourceKey,
      );
    }
    const appendedShape = appendBase
      ? (db
          .prepare(
            `WITH appended AS (
               SELECT entry_ordinal, entry_id, parent_id,
                 lag(entry_id) OVER (ORDER BY entry_ordinal) AS previous_entry_id
               FROM entries WHERE source_key = ? AND entry_ordinal > ?
             )
             SELECT count(*) AS count,
               sum(CASE WHEN parent_id = coalesce(previous_entry_id, ?) THEN 0 ELSE 1 END) AS bad
             FROM appended`,
          )
          .get(sourceKey, appendBase.ordinal, appendBase.entryId) as {
          count: number;
          bad: number | null;
        })
      : undefined;
    const extendsLatestLeaf =
      appendedShape !== undefined &&
      appendedShape.count > 0 &&
      Number(appendedShape.bad ?? 0) === 0;
    if (initialLinear) {
      // The common single-branch initial history is already persisted in path
      // order. Avoid materializing a corpus-sized recursive CTE just to set the
      // same flag on every row.
      db.prepare("UPDATE entries SET latest_persisted_path = 1 WHERE source_key = ?").run(
        sourceKey,
      );
    } else if (extendsLatestLeaf) {
      // The overwhelmingly common active-session append extends the current
      // latest leaf. Preserve old flags and mark only new chain entries so a
      // huge source does not need an O(history) rewrite for one new row.
      db.prepare(
        `UPDATE entries SET latest_persisted_path = 1
         WHERE source_key = ? AND entry_ordinal > ?`,
      ).run(sourceKey, appendBase!.ordinal);
    } else if (!appendBase || (appendedShape?.count ?? 0) > 0) {
      db.prepare("UPDATE entries SET latest_persisted_path = 0 WHERE source_key = ?").run(
        sourceKey,
      );
      // UNION (not UNION ALL) makes a cycle terminate without retaining the
      // source graph in JS. SQLite temp storage bounds worker heap for very
      // large linear histories while preserving deterministic persisted order.
      db.prepare(
        `WITH RECURSIVE
       latest_leaf(entry_ordinal, entry_id, parent_id) AS (
         SELECT entry_ordinal, entry_id, parent_id
         FROM entries candidate
         WHERE candidate.source_key = ?
           AND NOT EXISTS (
             SELECT 1 FROM entries child
             WHERE child.source_key = candidate.source_key
               AND child.parent_id = candidate.entry_id
           )
         ORDER BY entry_ordinal DESC, entry_id DESC
         LIMIT 1
       ),
       seed(entry_ordinal, entry_id, parent_id) AS (
         SELECT entry_ordinal, entry_id, parent_id FROM latest_leaf
         UNION ALL
         SELECT entry_ordinal, entry_id, parent_id
         FROM entries
         WHERE source_key = ?
           AND NOT EXISTS (SELECT 1 FROM latest_leaf)
         ORDER BY entry_ordinal DESC, entry_id DESC
         LIMIT 1
       ),
       persisted_path(entry_ordinal, entry_id, parent_id) AS (
         SELECT entry_ordinal, entry_id, parent_id FROM seed
         UNION
         SELECT parent.entry_ordinal, parent.entry_id, parent.parent_id
         FROM entries parent
         JOIN persisted_path child ON child.parent_id = parent.entry_id
         WHERE parent.source_key = ?
       )
       UPDATE entries SET latest_persisted_path = 1
       WHERE source_key = ?
         AND entry_ordinal IN (SELECT entry_ordinal FROM persisted_path)`,
      ).run(sourceKey, sourceKey, sourceKey, sourceKey);
    }
    db.prepare(
      `UPDATE sources SET health = ?, committed_offset = ?, committed_ordinal = ?,
       committed_tail_hash = ? WHERE source_key = ?`,
    ).run(
      partial ? "partial" : "indexed",
      committedOffset,
      committedOrdinal,
      committedTailHash(sourcePath, committedOffset, sourceRoot),
      sourceKey,
    );
    commitVisibleMutation(db);
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

async function indexSource(
  source: SearchWorkerSource,
  isCurrentRequest: () => boolean,
): Promise<void> {
  if (!isCurrentRequest()) return;
  const signature = sourceRevision(source);
  const existing = existingSource(source.canonicalPath);
  if (
    existing?.source_revision === signature &&
    (existing.health === "indexed" || existing.health === "partial")
  ) {
    updateSourceMetadata(source);
    return;
  }
  const append = existing && canAppend(existing, source) ? existing : undefined;
  const sourceKey = append
    ? beginAppend(source, signature, append)
    : beginSource(source, signature);
  const appendBase = append
    ? (requireDatabase()
        .prepare(
          `SELECT entry_ordinal AS ordinal, entry_id AS entryId
           FROM entries WHERE source_key = ? AND latest_persisted_path = 1
           ORDER BY entry_ordinal DESC LIMIT 1`,
        )
        .get(sourceKey) as { ordinal: number; entryId: string } | undefined)
    : undefined;
  let pending: PendingEntry[] = [];
  let pendingBytes = 0;
  let initialLinear = !append;
  let previousLinearEntryId: string | null = null;
  let partial = append?.health === "partial" || append?.health === "indexing-partial";
  let committedOffset = append?.committed_offset ?? 0;
  let committedOrdinal = append?.committed_ordinal ?? 0;
  const startOffset = committedOffset;
  try {
    for await (const row of streamJsonlRows(source.canonicalPath, {
      indexingMode: true,
      startOffset,
      startingOrdinal: committedOrdinal,
      includeSkipped: true,
      confinementRoot: source.sessionsRoot,
    })) {
      committedOffset = Math.max(committedOffset, row.nextByteOffset);
      committedOrdinal = Math.max(committedOrdinal, row.fileOrdinal);
      if (row.skippedReason) {
        partial = true;
        continue;
      }
      if (!append && row.fileOrdinal === 1) continue;
      const parsed = SessionEntrySchema.safeParse(row.value);
      if (!parsed.success) {
        partial = true;
        continue;
      }
      const raw = parsed.data as Record<string, unknown>;
      const id = typeof raw.id === "string" ? raw.id : undefined;
      if (!id) {
        partial = true;
        continue;
      }
      const timestamp =
        typeof raw.timestamp === "number"
          ? raw.timestamp
          : typeof raw.timestamp === "string"
            ? Date.parse(raw.timestamp)
            : null;
      const parentId = typeof raw.parentId === "string" ? raw.parentId : null;
      if (initialLinear && parentId !== previousLinearEntryId) initialLinear = false;
      previousLinearEntryId = id;
      const segments = extractSearchSegments(raw, {
        fileOrdinal: row.fileOrdinal,
        byteStart: row.byteStart,
        byteEnd: row.byteEnd,
      });
      pending.push({
        ordinal: row.fileOrdinal,
        id,
        parentId,
        timestamp: timestamp !== null && Number.isFinite(timestamp) ? timestamp : null,
        byteStart: row.byteStart,
        byteEnd: row.byteEnd,
        segments,
      });
      pendingBytes += segments.reduce(
        (sum, segment) => sum + Buffer.byteLength(segment.originalText, "utf8") + 256,
        128,
      );
      if (pending.length >= INDEX_TRANSACTION_ROWS || pendingBytes >= INDEX_TRANSACTION_BYTES) {
        if (!isCurrentRequest()) return;
        partial =
          commitEntries(sourceKey, pending, committedOffset, committedOrdinal, partial) > 0 ||
          partial;
        pending = [];
        pendingBytes = 0;
        await testingAfterChunkCommit?.(revision);
        await runPriorityRequests();
        if (!isCurrentRequest()) return;
      }
    }
    if (!isCurrentRequest()) return;
    if (pending.length > 0 || committedOffset > startOffset) {
      partial =
        commitEntries(sourceKey, pending, committedOffset, committedOrdinal, partial) > 0 ||
        partial;
    }
    recomputeGraphAndCommitSource(
      sourceKey,
      source.canonicalPath,
      source.sessionsRoot,
      committedOffset,
      committedOrdinal,
      partial,
      appendBase,
      initialLinear,
    );
  } catch (error) {
    const db = requireDatabase();
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare("UPDATE sources SET health = 'skipped' WHERE source_key = ?").run(sourceKey);
      commitVisibleMutation(db);
    } catch (updateError) {
      db.exec("ROLLBACK");
      throw updateError;
    }
    throw error;
  }
}

async function reconcile(
  sources: SearchWorkerSource[],
  force = false,
  completeCatalog = true,
): Promise<void> {
  const requestGeneration = ++reconcileGeneration;
  if (completeCatalog) latestSourceGeneration.clear();
  for (const source of sources) {
    latestSourceGeneration.set(source.canonicalPath, requestGeneration);
  }
  const db = requireDatabase();
  db.exec("BEGIN IMMEDIATE");
  let catalogMutation = false;
  try {
    if (completeCatalog) {
      // Reconcile deletion in SQLite rather than retaining an unbounded list
      // of known source paths in the worker heap.
      db.exec("CREATE TEMP TABLE IF NOT EXISTS incoming_sources(path TEXT PRIMARY KEY)");
      db.exec("DELETE FROM incoming_sources");
      const insertIncoming = db.prepare("INSERT OR IGNORE INTO incoming_sources(path) VALUES (?)");
      for (const source of sources) insertIncoming.run(source.canonicalPath);
      const removed = db
        .prepare(
          "DELETE FROM sources WHERE canonical_path NOT IN (SELECT path FROM incoming_sources)",
        )
        .run();
      catalogMutation = Number(removed.changes) > 0;
    }
    if (force) {
      const marked = db
        .prepare(
          "UPDATE sources SET health = 'rebuild-pending' WHERE health IS NOT 'rebuild-pending'",
        )
        .run();
      catalogMutation = Number(marked.changes) > 0 || catalogMutation;
    }
    if (catalogMutation) commitVisibleMutation(db);
    else db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  let skipped = 0;
  for (const source of sources) {
    const isCurrentRequest = () =>
      latestSourceGeneration.get(source.canonicalPath) === requestGeneration;
    if (!isCurrentRequest()) continue;
    try {
      await indexSource(source, isCurrentRequest);
    } catch {
      skipped++;
    }
    await runPriorityRequests();
  }
  updateCoverage();
  void skipped;
}

function ftsTerm(term: string, prefix: boolean): string {
  const escaped = term.replaceAll('"', '""');
  return `"${escaped}"${prefix ? "*" : ""}`;
}

function ftsExpression(
  terms: readonly { text: string; prefix: boolean }[],
  alternatives: ReadonlyMap<string, readonly string[]> = new Map(),
): string {
  const clauses: string[] = [];
  for (const term of terms) {
    clauses.push(ftsTerm(term.text, term.prefix));
    for (const alternative of alternatives.get(term.text) ?? []) {
      clauses.push(ftsTerm(alternative, false));
    }
  }
  return [...new Set(clauses)].join(" OR ");
}

function fetchCandidates(
  workspacePath: string,
  expression: string,
  allowedSourcePaths: readonly string[] | undefined,
  limit = MAX_CANDIDATES,
): CandidateRow[] {
  if (!expression) return [];
  return requireDatabase()
    .prepare(
      `SELECT
         seg.segment_id, seg.source_key, src.canonical_path, src.source_revision,
         src.workspace_path, src.session_id, src.session_name, src.worktree_name,
         seg.entry_ordinal, ent.byte_start, ent.byte_end, seg.entry_id,
         seg.content_part_key, seg.role, seg.timestamp_ms, seg.original_text,
         seg.normalized_text, seg.derived_text,
         seg.content_digest, ent.latest_persisted_path
       FROM segments_fts
       JOIN segments seg ON seg.segment_id = segments_fts.rowid
       JOIN sources src ON src.source_key = seg.source_key
       JOIN entries ent ON ent.source_key = seg.source_key
         AND ent.entry_ordinal = seg.entry_ordinal
       WHERE segments_fts MATCH ?
         AND src.workspace_path = ?
         AND src.archived = 0
         AND src.health IN ('indexed', 'partial', 'indexing', 'indexing-partial')
         AND (? IS NULL OR src.canonical_path IN (SELECT value FROM json_each(?)))
       ORDER BY bm25(segments_fts), seg.segment_id
       LIMIT ?`,
    )
    .all(
      expression,
      workspacePath,
      allowedSourcePaths ? JSON.stringify(allowedSourcePaths) : null,
      allowedSourcePaths ? JSON.stringify(allowedSourcePaths) : null,
      Math.min(MAX_CANDIDATES, Math.max(1, limit)),
    ) as unknown as CandidateRow[];
}

function queryDictionary(terms: readonly string[]): Map<string, readonly string[]> {
  const dictionaryRows = requireDatabase()
    .prepare(
      `SELECT term FROM segments_vocab
       WHERE length(term) BETWEEN 4 AND 40
       ORDER BY doc DESC, term
       LIMIT ?`,
    )
    .all(MAX_DICTIONARY_TERMS) as Array<{ term: string }>;
  const dictionary = dictionaryRows.map((row) => row.term);
  return new Map(terms.map((term) => [term, findTypoAlternatives(term, dictionary)]));
}

function termInCandidate(
  term: { text: string; quoted: boolean; prefix: boolean },
  candidate: CandidateRow,
): boolean {
  if (term.quoted) return candidate.normalized_text.includes(term.text);
  const values = `${candidate.normalized_text} ${candidate.derived_text}`.split(/\s+/u);
  return values.some((value) => (term.prefix ? value.startsWith(term.text) : value === term.text));
}

function resultRanges(
  text: string,
  terms: readonly { text: string; quoted: boolean; prefix: boolean }[],
  alternatives: ReadonlyMap<string, readonly string[]>,
): { ranges: Array<{ start: number; end: number }>; logicalOccurrences: number } {
  const ranges: Array<{ start: number; end: number }> = [];
  let singleTermOccurrences = 0;
  for (const term of terms) {
    const exact = findOriginalMatchRangesBounded(
      text,
      term.text,
      MAX_RESULT_OCCURRENCES_PER_SEGMENT,
    );
    if (exact.total > 0) {
      ranges.push(...exact.ranges);
      if (terms.length === 1) singleTermOccurrences += exact.total;
      continue;
    }
    for (const alternative of alternatives.get(term.text) ?? []) {
      const close = findOriginalMatchRangesBounded(
        text,
        alternative,
        MAX_RESULT_OCCURRENCES_PER_SEGMENT - ranges.length,
      );
      ranges.push(...close.ranges);
      if (terms.length === 1) singleTermOccurrences += close.total;
      if (ranges.length >= MAX_RESULT_OCCURRENCES_PER_SEGMENT) break;
    }
  }
  const unique = ranges
    .sort((a, b) => a.start - b.start || a.end - b.end)
    .filter(
      (range, index, all) =>
        index === 0 || all[index - 1]?.start !== range.start || all[index - 1]?.end !== range.end,
    )
    .slice(0, MAX_RESULT_OCCURRENCES_PER_SEGMENT);
  // Multi-term ranges are contributing highlights for one logical segment
  // match, not separate occurrences that consume session-diversity slots.
  return {
    ranges: unique,
    logicalOccurrences: terms.length === 1 ? Math.max(1, singleTermOccurrences) : 1,
  };
}

function runQuery(
  workspacePath: string,
  rawQuery: string,
  offset: number,
  limit: number,
  pinnedSourcePaths: string[],
  expandedSourcePaths: string[] = [],
  allowedSourcePaths?: string[] | undefined,
): { matches: SearchWorkerMatch[]; total: number; truncated: boolean } {
  const parsed = parseSearchQuery(rawQuery);
  if (!parsed.terms.length) return { matches: [], total: 0, truncated: false };
  let alternatives = new Map<string, readonly string[]>();
  let candidateStageTruncated = false;
  const collectCandidates = (
    typoAlternatives: ReadonlyMap<string, readonly string[]> = new Map(),
  ): CandidateRow[] => {
    const unique = new Map<number, CandidateRow>();
    const perTermLimit = Math.max(100, Math.floor(MAX_CANDIDATES / parsed.terms.length));
    for (const term of parsed.terms) {
      const fetched = fetchCandidates(
        workspacePath,
        ftsExpression([term], typoAlternatives),
        allowedSourcePaths,
        perTermLimit,
      );
      if (fetched.length >= perTermLimit) candidateStageTruncated = true;
      for (const candidate of fetched) {
        if (!unique.has(candidate.segment_id)) unique.set(candidate.segment_id, candidate);
        if (unique.size >= MAX_CANDIDATES) break;
      }
      if (unique.size >= MAX_CANDIDATES) break;
    }
    return [...unique.values()];
  };
  const pinned = new Set(pinnedSourcePaths);
  const buildEligible = (candidateRows: CandidateRow[]) => {
    const rankable = candidateRows.map((candidate) => ({
      id: String(candidate.segment_id),
      sessionId: candidate.session_id,
      role: candidate.role,
      normalizedText: candidate.normalized_text,
      derivedComponents: candidate.derived_text.split(/\s+/u),
      fileOrdinal: candidate.entry_ordinal,
      timestamp: candidate.timestamp_ms,
      pinned: pinned.has(candidate.canonical_path),
      candidate,
    }));
    const prelim = rankSearchCandidates(rankable, parsed, MAX_CANDIDATES);
    const bySource = new Map<number, CandidateRow[]>();
    for (const candidate of candidateRows) {
      const existing = bySource.get(candidate.source_key) ?? [];
      existing.push(candidate);
      bySource.set(candidate.source_key, existing);
    }
    return prelim.flatMap((ranked) => {
      const own = new Set(ranked.matchedTerms);
      const nearby = bySource.get(ranked.segment.candidate.source_key) ?? [];
      let neighboringTermCount = 0;
      for (const term of parsed.terms) {
        if (own.has(term.text)) continue;
        if (
          nearby.some(
            (candidate) =>
              Math.abs(candidate.entry_ordinal - ranked.segment.candidate.entry_ordinal) <= 2 &&
              termInCandidate(term, candidate),
          )
        ) {
          neighboringTermCount++;
        }
      }
      return own.size + neighboringTermCount >= new Set(parsed.terms.map((term) => term.text)).size
        ? [{ ...ranked.segment, neighboringTermCount }]
        : [];
    });
  };
  let candidates = collectCandidates();
  let eligible = buildEligible(candidates);
  if (eligible.length === 0) {
    alternatives = queryDictionary(parsed.terms.map((term) => term.text));
    candidates = collectCandidates(alternatives);
    eligible = buildEligible(candidates);
  }
  const reranked = rankSearchCandidates(eligible, parsed, MAX_CANDIDATES);
  const expanded: SearchWorkerMatch[] = [];
  const totalBySession = new Map<string, number>();
  let occurrenceStageTruncated = false;
  for (const ranked of reranked) {
    const candidate = ranked.segment.candidate;
    const rangeResult = resultRanges(candidate.original_text, parsed.terms, alternatives);
    const ranges = rangeResult.ranges;
    const repeatedSingleTerm = parsed.terms.length === 1;
    const occurrenceRanges = repeatedSingleTerm
      ? ranges.length
        ? ranges
        : [{ start: 0, end: 0 }]
      : [ranges[0] ?? { start: 0, end: 0 }];
    const sessionKey = `${candidate.canonical_path}\0${candidate.session_id}`;
    totalBySession.set(
      sessionKey,
      (totalBySession.get(sessionKey) ?? 0) + rangeResult.logicalOccurrences,
    );
    if (rangeResult.logicalOccurrences > occurrenceRanges.length) occurrenceStageTruncated = true;
    for (const [occurrence, sourceRange] of occurrenceRanges.entries()) {
      const snippet = createSnippet(candidate.original_text, ranges, { occurrence, context: 100 });
      expanded.push({
        sourcePath: candidate.canonical_path,
        sourceRevision: candidate.source_revision,
        workspacePath: candidate.workspace_path,
        sessionId: candidate.session_id,
        sessionName: candidate.session_name,
        ...(candidate.worktree_name ? { worktreeName: candidate.worktree_name } : {}),
        entryOrdinal: candidate.entry_ordinal,
        byteStart: candidate.byte_start,
        byteEnd: candidate.byte_end,
        entryId: candidate.entry_id,
        contentPartKey: candidate.content_part_key,
        occurrence,
        contentDigest: candidate.content_digest,
        role: candidate.role,
        timestamp: candidate.timestamp_ms,
        snippet: snippet.text,
        matchRanges: snippet.matchRanges.map((range) => ({ ...range })),
        sourceMatchRanges: repeatedSingleTerm
          ? sourceRange.end > sourceRange.start
            ? [sourceRange]
            : []
          : ranges,
        latestPersistedPath: candidate.latest_persisted_path === 1,
        additionalMatches: 0,
        score: ranked.score - occurrence * 0.001,
        ...(ranked.closeMatchTerms[0] ? { closeMatchTerm: ranked.closeMatchTerms[0] } : {}),
      });
    }
  }
  expanded.sort(
    (a, b) =>
      b.score - a.score ||
      b.entryOrdinal - a.entryOrdinal ||
      a.sourcePath.localeCompare(b.sourcePath) ||
      a.contentPartKey.localeCompare(b.contentPartKey) ||
      a.occurrence - b.occurrence,
  );
  // Group by the catalogued source identity, never by its mutable display
  // name. This happens before slicing so a busy session cannot consume a page
  // and hide other sessions. The representative keeps its opaque target data;
  // the count describes the remaining persisted matches in that same source.
  void expandedSourcePaths;
  const grouped: SearchWorkerMatch[] = [];
  const representedSources = new Set<string>();
  for (const match of expanded) {
    const sourceKey = `${match.sourcePath}\0${match.sessionId}`;
    if (representedSources.has(sourceKey)) continue;
    representedSources.add(sourceKey);
    grouped.push({
      ...match,
      additionalMatches: Math.max(0, (totalBySession.get(sourceKey) ?? 1) - 1),
    });
  }
  return {
    matches: grouped.slice(Math.max(0, offset), Math.max(0, offset) + Math.max(1, limit)),
    total: grouped.length,
    truncated:
      candidateStageTruncated || candidates.length >= MAX_CANDIDATES || occurrenceStageTruncated,
  };
}

async function dispatch(request: SearchWorkerRequest): Promise<SearchWorkerResponse> {
  try {
    switch (request.type) {
      case "initialize":
        await initialize(request.databaseDirectory);
        return { id: request.id, ok: true, type: "initialized", revision, coverage };
      case "reconcile":
        await reconcile(request.sources, false, request.completeCatalog ?? true);
        return { id: request.id, ok: true, type: "reconciled", revision, coverage };
      case "rebuild":
        await reconcile(request.sources, true);
        return { id: request.id, ok: true, type: "rebuilt", revision, coverage };
      case "query": {
        const result = runQuery(
          request.workspacePath,
          request.query,
          request.offset,
          request.limit,
          request.pinnedSourcePaths,
          request.expandedSourcePaths,
          request.allowedSourcePaths,
        );
        return {
          id: request.id,
          ok: true,
          type: "query",
          revision,
          matches: result.matches,
          total: result.total,
          truncated: result.truncated,
          coverage: databaseCoverage(request.workspacePath),
        };
      }
      case "context":
        return {
          id: request.id,
          ok: true,
          type: "context",
          result: await loadContextFromValidatedSource(
            request.source,
            request.target,
            request.options,
            () => runPriorityRequests(false),
            request.sourceDescriptor,
          ),
        };
      case "validate":
        return {
          id: request.id,
          ok: true,
          type: "validate",
          valid: await validateExactTarget(
            request.source,
            request.target,
            request.sourceDescriptor,
          ),
        };
      case "status":
        updateCoverage();
        return {
          id: request.id,
          ok: true,
          type: "status",
          revision,
          coverage: databaseCoverage(request.workspacePath),
        };
      case "shutdown":
        shuttingDown = true;
        database?.close();
        database = null;
        return { id: request.id, ok: true, type: "shutdown" };
    }
  } catch (error) {
    return {
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      recoverable: request.type !== "initialize",
    };
  }
}

async function pump(): Promise<void> {
  if (pumping) return;
  pumping = true;
  try {
    while (!shuttingDown) {
      const item = priorityQueue.shift() ?? backgroundQueue.shift();
      if (!item) break;
      const response = await dispatch(item.request);
      parentPort?.postMessage(response);
    }
  } finally {
    pumping = false;
  }
}

export const sessionSearchWorkerTesting = {
  initialize,
  reconcile,
  runQuery,
  coverage: databaseCoverage,
  isPriorityRequest,
  currentRevision: () => revision,
  setAfterChunkCommit(hook: ((revision: number) => Promise<void> | void) | null): void {
    testingAfterChunkCommit = hook;
  },
  close(): void {
    database?.close();
    database = null;
    databasePath = null;
    revision = 0;
    coverage = { indexedSources: 0, totalSources: 0, skippedSources: 0 };
    testingAfterChunkCommit = null;
    reconcileGeneration = 0;
    latestSourceGeneration.clear();
  },
};

if (parentPort) {
  parentPort.on("message", (request: SearchWorkerRequest) => {
    const queue = isPriorityRequest(request) ? priorityQueue : backgroundQueue;
    queue.push({ request });
    void pump();
  });
}
