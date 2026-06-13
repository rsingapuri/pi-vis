import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SessionSummary } from "@shared/ipc-contract.js";
import { SessionHeaderSchema } from "@shared/session-file/entries.js";

// Read per call so tests can override PIVIS_SESSIONS_DIR.
function getSessionsDir(): string {
  return process.env["PIVIS_SESSIONS_DIR"] ?? path.join(os.homedir(), ".pi", "agent", "sessions");
}

// Cache: filePath → { mtime, summary }
const cache = new Map<string, { mtime: number; summary: SessionSummary }>();

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

export function extractSessionMeta(filePath: string): {
  preview: string;
  messageCount: number;
  name: string | null;
} {
  let preview = "";
  let messageCount = 0;
  let name: string | null = null;
  try {
    const content = fs.readFileSync(filePath, "utf8");
    const lines = content.split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as Record<string, unknown>;
        if (entry["type"] === "message") {
          // Real pi v3 nests message data under a `message` key.
          const msg = entry["message"] as Record<string, unknown> | undefined;
          if (msg && msg["role"] === "user") {
            messageCount++;
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
        if (
          entry["type"] === "session_info" &&
          typeof entry["name"] === "string" &&
          entry["name"]
        ) {
          name = entry["name"];
        }
      } catch {
        /* skip bad lines */
      }
    }
  } catch {
    /* ignore */
  }
  return { preview, messageCount, name };
}

export async function listSessionsForWorkspace(workspacePath: string): Promise<SessionSummary[]> {
  const results: SessionSummary[] = [];
  const SESSIONS_DIR = getSessionsDir();

  if (!fs.existsSync(SESSIONS_DIR)) return results;

  let subdirs: string[];
  try {
    subdirs = fs.readdirSync(SESSIONS_DIR);
  } catch {
    return results;
  }

  for (const subdir of subdirs) {
    const subdirPath = path.join(SESSIONS_DIR, subdir);
    let files: string[];
    try {
      const stat = fs.statSync(subdirPath);
      if (!stat.isDirectory()) continue;
      files = fs.readdirSync(subdirPath).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }

    for (const file of files) {
      const filePath = path.join(subdirPath, file);
      let mtime: number;
      try {
        mtime = fs.statSync(filePath).mtimeMs;
      } catch {
        continue;
      }

      // Check cache
      const cached = cache.get(filePath);
      if (cached && cached.mtime === mtime) {
        if (cached.summary.cwd === workspacePath) {
          results.push(cached.summary);
        }
        continue;
      }

      const headerLine = readFirstLine(filePath);
      if (!headerLine) continue;

      let header: ReturnType<typeof SessionHeaderSchema.safeParse>;
      try {
        header = SessionHeaderSchema.safeParse(JSON.parse(headerLine));
      } catch {
        continue;
      }

      if (!header.success) continue;

      const { preview, messageCount, name } = extractSessionMeta(filePath);

      const summary: SessionSummary = {
        filePath,
        id: header.data.id,
        ...(name ? { name } : {}),
        mtime,
        preview,
        messageCount,
        cwd: header.data.cwd,
      };

      // Cache entries for ALL workspaces, not just the one we are
      // enumerating. Without this, switching workspaces re-parses every
      // file from disk on each call.
      cache.set(filePath, { mtime, summary });
      if (header.data.cwd !== workspacePath) continue;
      results.push(summary);
    }
  }

  // Sort by most recent first
  results.sort((a, b) => b.mtime - a.mtime);
  return results;
}
