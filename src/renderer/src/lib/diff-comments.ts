import type { SessionId } from "@shared/ids.js";

export type CodeCommentAnchorStatus = "current" | "relocated" | "stale";

export interface CodeComment {
  /** Stable identity used to clear exactly the submitted revision after send. */
  id: string;
  filePath: string;
  lineNumber: number;
  /** Line number where the user originally placed the comment. */
  originalLineNumber: number;
  /** New-side line text at the time the comment was placed/last edited. */
  lineText: string;
  /** Whether the saved line text still matches the current diff location. */
  anchorStatus: CodeCommentAnchorStatus;
  text: string;
  /** Monotonic user-edit revision. Anchor reconciliation deliberately preserves it. */
  revision: number;
  createdAt: number;
  /** User-edit timestamp. Anchor reconciliation deliberately preserves it. */
  updatedAt: number;
}

export const DIFF_COMMENTS_STORAGE_KEY = "pivis.diffComments.v2";
export const DIFF_COMMENTS_SESSION_STORAGE_KEY = "pivis.diffComments.v1";

export function codeCommentKey(filePath: string, lineNumber: number): string {
  return `${filePath}\u0000${lineNumber}`;
}

export function createCodeCommentId(): string {
  try {
    const uuid = globalThis.crypto?.randomUUID?.();
    if (uuid) return uuid;
  } catch {
    // fall through
  }
  return `comment-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function sortCodeComments(comments: readonly CodeComment[]): CodeComment[] {
  return [...comments].sort((a, b) => {
    const pathCmp = a.filePath.localeCompare(b.filePath);
    if (pathCmp !== 0) return pathCmp;
    return a.lineNumber - b.lineNumber;
  });
}

export function formatCodeCommentsMarkdown(comments: readonly CodeComment[]): string {
  const sorted = sortCodeComments(comments);
  const sections = sorted.map((comment, index) => {
    const text = comment.text.trim();
    const anchorLines: string[] = [];
    if (comment.anchorStatus === "relocated") {
      anchorLines.push(`Anchor: relocated from line ${comment.originalLineNumber}`);
    } else if (comment.anchorStatus === "stale") {
      anchorLines.push("Anchor: stale - the saved line text no longer matches this line");
      anchorLines.push(`Original line: ${comment.originalLineNumber}`);
    }
    if (comment.lineText !== "") {
      anchorLines.push(`Line text: ${comment.lineText}`);
    }
    const metadata = [`File: ${comment.filePath}`, `Line: ${comment.lineNumber}`, ...anchorLines];
    return `## Comment ${index + 1}\n${metadata.join("\n")}\n${text}`;
  });
  return `### User comments on the code\n\n${sections.join("\n\n")}\n\n* * *`;
}

export function prependCodeCommentsToPrompt(
  prompt: string,
  comments: readonly CodeComment[],
): string {
  if (comments.length === 0) return prompt;
  const separator = prompt.length === 0 || /^\r?\n/.test(prompt) ? "" : "\n\n";
  return `${formatCodeCommentsMarkdown(comments)}${separator}${prompt}`;
}

type PersistedComments = Record<string, CodeComment[]>;

function storageArea(kind: "local" | "session"): Storage | null {
  if (typeof window === "undefined" || !("document" in window)) return null;
  try {
    return kind === "local" ? window.localStorage : window.sessionStorage;
  } catch {
    return null;
  }
}

function parsePersistedComment(value: unknown): CodeComment | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<CodeComment>;
  if (typeof raw.filePath !== "string" || raw.filePath.length === 0) return null;
  const lineNumber = raw.lineNumber;
  if (typeof lineNumber !== "number" || !Number.isInteger(lineNumber) || lineNumber < 1) {
    return null;
  }
  if (typeof raw.text !== "string" || raw.text.trim().length === 0) return null;
  const createdAt = typeof raw.createdAt === "number" ? raw.createdAt : Date.now();
  const updatedAt = typeof raw.updatedAt === "number" ? raw.updatedAt : createdAt;
  const revision = typeof raw.revision === "number" && raw.revision > 0 ? raw.revision : 1;
  const id = typeof raw.id === "string" && raw.id ? raw.id : createCodeCommentId();
  const originalLineNumber =
    typeof raw.originalLineNumber === "number" && Number.isInteger(raw.originalLineNumber)
      ? raw.originalLineNumber
      : lineNumber;
  const lineText = typeof raw.lineText === "string" ? raw.lineText : "";
  const anchorStatus =
    raw.anchorStatus === "relocated" || raw.anchorStatus === "stale" ? raw.anchorStatus : "current";
  return {
    id,
    filePath: raw.filePath,
    lineNumber,
    originalLineNumber,
    lineText,
    anchorStatus,
    text: raw.text,
    revision,
    createdAt,
    updatedAt,
  };
}

function loadFromRaw(raw: string | null): Map<SessionId, Map<string, CodeComment>> {
  const out = new Map<SessionId, Map<string, CodeComment>>();
  if (!raw) return out;
  try {
    const parsed = JSON.parse(raw) as PersistedComments;
    if (!parsed || typeof parsed !== "object") return out;
    for (const [sessionId, comments] of Object.entries(parsed)) {
      if (!Array.isArray(comments)) continue;
      const sessionComments = new Map<string, CodeComment>();
      for (const rawComment of comments) {
        const comment = parsePersistedComment(rawComment);
        if (!comment) continue;
        sessionComments.set(codeCommentKey(comment.filePath, comment.lineNumber), comment);
      }
      if (sessionComments.size > 0) {
        out.set(sessionId as SessionId, sessionComments);
      }
    }
  } catch {
    return out;
  }
  return out;
}

export function loadPersistedCodeComments(): Map<SessionId, Map<string, CodeComment>> {
  const local = storageArea("local");
  const session = storageArea("session");
  const current = loadFromRaw(local?.getItem(DIFF_COMMENTS_STORAGE_KEY) ?? null);
  if (current.size > 0) return current;

  // Best-effort migration from the original sessionStorage-backed version.
  const legacy = loadFromRaw(session?.getItem(DIFF_COMMENTS_SESSION_STORAGE_KEY) ?? null);
  if (legacy.size > 0) {
    persistCodeComments(legacy);
    try {
      session?.removeItem(DIFF_COMMENTS_SESSION_STORAGE_KEY);
    } catch {
      // ignore
    }
  }
  return legacy;
}

export function persistCodeComments(
  commentsBySession: Map<SessionId, Map<string, CodeComment>>,
): void {
  const local = storageArea("local");
  if (!local) return;
  const persisted: PersistedComments = {};
  for (const [sessionId, comments] of commentsBySession) {
    if (comments.size === 0) continue;
    persisted[sessionId] = sortCodeComments(Array.from(comments.values()));
  }
  try {
    if (Object.keys(persisted).length === 0) {
      local.removeItem(DIFF_COMMENTS_STORAGE_KEY);
    } else {
      local.setItem(DIFF_COMMENTS_STORAGE_KEY, JSON.stringify(persisted));
    }
  } catch {
    // Best-effort durable renderer persistence; in-memory state remains authoritative.
  }
}
