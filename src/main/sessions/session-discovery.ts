import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { SessionSummary, WorktreeIdentity } from "@shared/ipc-contract.js";
import { SessionHeaderSchema } from "@shared/session-file/entries.js";
import { getSettings } from "../settings-store.js";

// Read per call so tests can override PIVIS_SESSIONS_DIR.
function getSessionsDir(): string {
  return process.env["PIVIS_SESSIONS_DIR"] ?? path.join(os.homedir(), ".pi", "agent", "sessions");
}

// Cache: filePath → { mtime, summary }
const cache = new Map<string, { mtime: number; summary: SessionSummary }>();

// Discovery runs on the main process IPC path. Never read arbitrarily large
// session files into memory while listing the sidebar; sample the start (for
// preview) and the end (for recent session_info / user activity) instead.
const SESSION_META_CHUNK_BYTES = 1024 * 1024;

async function readFirstLineAsync(filePath: string): Promise<string | null> {
  let handle: fsp.FileHandle | null = null;
  try {
    handle = await fsp.open(filePath, "r");
    const buf = Buffer.alloc(4096);
    const { bytesRead } = await handle.read(buf, 0, 4096, 0);
    const text = buf.slice(0, bytesRead).toString("utf8");
    const newline = text.indexOf("\n");
    return newline === -1 ? text : text.slice(0, newline);
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

function readFirstLine(filePath: string): string | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, "r");
    const buf = Buffer.alloc(4096);
    const bytesRead = fs.readSync(fd, buf, 0, 4096, 0);
    const text = buf.slice(0, bytesRead).toString("utf8");
    const newline = text.indexOf("\n");
    return newline === -1 ? text : text.slice(0, newline);
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

/** Parse a session-file entry timestamp (ISO string or epoch-ms number)
 *  into epoch milliseconds. Returns `undefined` for missing/unparseable
 *  values so callers can skip them when computing a max. */
function toEpochMs(ts: unknown): number | undefined {
  if (typeof ts === "number" && Number.isFinite(ts)) return ts;
  if (typeof ts === "string") {
    const ms = Date.parse(ts);
    if (Number.isFinite(ms)) return ms;
  }
  return undefined;
}

export interface ExtractedSessionMeta {
  preview: string;
  messageCount: number;
  name: string | null;
  /** Epoch-ms of the most recent *user-authored* entry (prompt or `!bash`),
   *  derived from the sampled session file. Unlike `mtime`, this is unaffected
   *  by passive operations (e.g. merely opening a session, which makes pi
   *  append a `session_info` entry and bump the file mtime). Used as the
   *  persistent sidebar sort key so a session you actively worked in stays
   *  above ones you only glanced at. `null` when the sampled file has no user
   *  messages (e.g. brand-new/empty sessions) — callers fall back to `mtime`. */
  lastActiveAt: number | null;
}

function parseSessionMetaLines(lines: string[]): ExtractedSessionMeta {
  let preview = "";
  let messageCount = 0;
  let name: string | null = null;
  let lastActiveAt: number | null = null;

  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as Record<string, unknown>;
      if (entry["type"] === "message") {
        // Real pi v3 nests message data under a `message` key.
        const msg = entry["message"] as Record<string, unknown> | undefined;
        if (msg && msg["role"] === "user") {
          messageCount++;
          // Track the most recent user-authored activity. Prefer the
          // entry-level timestamp; fall back to the message-level one
          // (pi v3 also stamps the nested message object).
          const ms = toEpochMs(entry["timestamp"]) ?? toEpochMs(msg["timestamp"]);
          if (ms !== undefined && (lastActiveAt === null || ms > lastActiveAt)) {
            lastActiveAt = ms;
          }
          if (!preview) {
            const body = msg["content"];
            if (typeof body === "string") {
              preview = body.slice(0, 100);
            } else if (Array.isArray(body)) {
              const first = body[0] as Record<string, unknown> | undefined;
              if (first && typeof first["text"] === "string") {
                preview = first["text"].slice(0, 100);
              }
            }
          }
        }
      }
      if (entry["type"] === "session_info" && typeof entry["name"] === "string" && entry["name"]) {
        name = entry["name"];
      }
    } catch {
      /* skip bad lines */
    }
  }

  return { preview, messageCount, name, lastActiveAt };
}

function linesFromBoundedChunks(head: string, tail?: string): string[] {
  const lines: string[] = [];
  const headParts = head.split("\n");
  const headComplete = head.endsWith("\n");
  lines.push(...(headComplete ? headParts : headParts.slice(0, -1)));

  if (tail !== undefined) {
    const tailParts = tail.split("\n");
    // The tail chunk usually starts in the middle of a JSONL row; drop that
    // partial first line. If the file fit in the head chunk, no tail is passed.
    lines.push(...tailParts.slice(1));
  }

  return lines;
}

function extractSessionMetaFromSample(head: string, tail?: string): ExtractedSessionMeta {
  return parseSessionMetaLines(linesFromBoundedChunks(head, tail));
}

async function readSessionMetaSample(filePath: string): Promise<{ head: string; tail?: string }> {
  const stat = await fsp.stat(filePath);
  if (stat.size <= SESSION_META_CHUNK_BYTES) {
    return { head: await fsp.readFile(filePath, "utf8") };
  }

  const handle = await fsp.open(filePath, "r");
  try {
    const headBuffer = Buffer.alloc(SESSION_META_CHUNK_BYTES);
    const { bytesRead: headBytes } = await handle.read(headBuffer, 0, SESSION_META_CHUNK_BYTES, 0);
    const tailSize = Math.min(SESSION_META_CHUNK_BYTES, stat.size - headBytes);
    const tailBuffer = Buffer.alloc(tailSize);
    const tailStart = Math.max(headBytes, stat.size - tailSize);
    const { bytesRead: tailBytes } = await handle.read(tailBuffer, 0, tailSize, tailStart);
    return {
      head: headBuffer.slice(0, headBytes).toString("utf8"),
      tail: tailBuffer.slice(0, tailBytes).toString("utf8"),
    };
  } finally {
    await handle.close().catch(() => {});
  }
}

function readSessionMetaSampleSync(filePath: string): { head: string; tail?: string } {
  const stat = fs.statSync(filePath);
  if (stat.size <= SESSION_META_CHUNK_BYTES) {
    return { head: fs.readFileSync(filePath, "utf8") };
  }

  const fd = fs.openSync(filePath, "r");
  try {
    const headBuffer = Buffer.alloc(SESSION_META_CHUNK_BYTES);
    const headBytes = fs.readSync(fd, headBuffer, 0, SESSION_META_CHUNK_BYTES, 0);
    const tailSize = Math.min(SESSION_META_CHUNK_BYTES, stat.size - headBytes);
    const tailBuffer = Buffer.alloc(tailSize);
    const tailStart = Math.max(headBytes, stat.size - tailSize);
    const tailBytes = fs.readSync(fd, tailBuffer, 0, tailSize, tailStart);
    return {
      head: headBuffer.slice(0, headBytes).toString("utf8"),
      tail: tailBuffer.slice(0, tailBytes).toString("utf8"),
    };
  } finally {
    fs.closeSync(fd);
  }
}

export async function extractSessionMetaAsync(filePath: string): Promise<ExtractedSessionMeta> {
  try {
    const { head, tail } = await readSessionMetaSample(filePath);
    return extractSessionMetaFromSample(head, tail);
  } catch {
    return { preview: "", messageCount: 0, name: null, lastActiveAt: null };
  }
}

export function extractSessionMeta(filePath: string): ExtractedSessionMeta {
  try {
    const { head, tail } = readSessionMetaSampleSync(filePath);
    return extractSessionMetaFromSample(head, tail);
  } catch {
    return { preview: "", messageCount: 0, name: null, lastActiveAt: null };
  }
}

/**
 * Resolve a session file to its worktree identity, if it belongs to a
 * known worktree of `workspacePath`. Reads the header `cwd` and looks it
 * up in settings.worktrees (persisted at worktree-creation time). Returns
 * undefined for normal workspace sessions, for sessions whose worktree
 * was deleted from disk (so pi spawns in the workspace instead of a
 * missing cwd), or when the worktree belongs to a different workspace.
 */
export function resolveWorktreeForFile(
  filePath: string,
  workspacePath: string,
): WorktreeIdentity | undefined {
  const first = readFirstLine(filePath);
  if (!first) return undefined;
  let header: { cwd?: unknown } | undefined;
  try {
    header = JSON.parse(first) as { cwd?: unknown };
  } catch {
    return undefined;
  }
  const cwd = typeof header?.cwd === "string" ? header.cwd : undefined;
  if (!cwd || cwd === workspacePath) return undefined;
  const wt = getSettings().worktrees?.[cwd];
  if (!wt || wt.workspacePath !== workspacePath) return undefined;
  // Don't claim a worktree whose directory no longer exists — the session
  // would otherwise try to spawn pi in a missing cwd. Fall back to the
  // workspace so the session is still openable.
  if (!fs.existsSync(cwd)) return undefined;
  return { path: cwd, branch: wt.branch, name: wt.name, base: wt.base };
}

export async function listSessionsForWorkspace(workspacePath: string): Promise<SessionSummary[]> {
  const results: SessionSummary[] = [];
  const SESSIONS_DIR = getSessionsDir();

  try {
    const stat = await fsp.stat(SESSIONS_DIR);
    if (!stat.isDirectory()) return results;
  } catch {
    return results;
  }

  // Worktrees belonging to this workspace. A session whose header `cwd` is
  // one of these worktree paths is shown under the parent workspace even
  // though its file lives elsewhere on disk (pi writes the worktree cwd
  // into the header). Without this, worktree sessions vanish on relaunch.
  const worktreeCwds = new Set<string>();
  for (const [wtPath, wt] of Object.entries(getSettings().worktrees ?? {})) {
    if (wt.workspacePath === workspacePath) worktreeCwds.add(wtPath);
  }

  let subdirs: string[];
  try {
    subdirs = await fsp.readdir(SESSIONS_DIR);
  } catch {
    return results;
  }

  for (const subdir of subdirs) {
    const subdirPath = path.join(SESSIONS_DIR, subdir);
    let files: string[];
    try {
      const stat = await fsp.stat(subdirPath);
      if (!stat.isDirectory()) continue;
      files = (await fsp.readdir(subdirPath)).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }

    for (const file of files) {
      const filePath = path.join(subdirPath, file);
      let mtime: number;
      try {
        mtime = (await fsp.stat(filePath)).mtimeMs;
      } catch {
        continue;
      }

      // Check cache
      const cached = cache.get(filePath);
      if (cached && cached.mtime === mtime) {
        if (cached.summary.cwd === workspacePath || worktreeCwds.has(cached.summary.cwd)) {
          results.push(cached.summary);
        }
        continue;
      }

      const headerLine = await readFirstLineAsync(filePath);
      if (!headerLine) continue;

      let header: ReturnType<typeof SessionHeaderSchema.safeParse>;
      try {
        header = SessionHeaderSchema.safeParse(JSON.parse(headerLine));
      } catch {
        continue;
      }

      if (!header.success) continue;

      const { preview, messageCount, name, lastActiveAt } = await extractSessionMetaAsync(filePath);

      const summary: SessionSummary = {
        filePath,
        id: header.data.id,
        ...(name ? { name } : {}),
        mtime,
        ...(lastActiveAt !== null ? { lastActiveAt } : {}),
        preview,
        messageCount,
        cwd: header.data.cwd,
      };

      // Cache entries for ALL workspaces, not just the one we are
      // enumerating. Without this, switching workspaces re-parses every
      // file from disk on each call.
      cache.set(filePath, { mtime, summary });
      if (header.data.cwd !== workspacePath && !worktreeCwds.has(header.data.cwd)) continue;
      results.push(summary);
    }
  }

  // Sort by most recent *user activity* first (prompts / `!bash`), falling
  // back to file mtime for sessions with no user messages (e.g. brand-new or
  // externally-created sessions). This is the persistent ordering the sidebar
  // relies on: unlike mtime it isn't bumped by merely opening a session.
  results.sort((a, b) => (b.lastActiveAt ?? b.mtime) - (a.lastActiveAt ?? a.mtime));

  // Filter out archived sessions
  const archived = new Set(getSettings().archivedSessions);
  return results.filter((s) => !archived.has(s.filePath));
}
