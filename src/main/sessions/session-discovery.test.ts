import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { saveSettings } from "../settings-store.js";
import {
  extractSessionMeta,
  listSessionsForWorkspace,
  resolveWorktreeForFile,
} from "./session-discovery.js";

let root: string;
let sessionsEnvBackup: string | undefined;
let settingsEnvBackup: string | undefined;

beforeEach(() => {
  sessionsEnvBackup = process.env["PIVIS_SESSIONS_DIR"];
  settingsEnvBackup = process.env["PIVIS_SETTINGS_DIR"];
  root = fs.mkdtempSync(path.join(os.tmpdir(), "pivis-discovery-"));
  process.env["PIVIS_SESSIONS_DIR"] = root;
  fs.mkdirSync(path.join(root, "workspace-A"), { recursive: true });
  // Isolate settings to a temp dir so worktree associations don't leak
  // between tests or touch the user's real settings.json.
  process.env["PIVIS_SETTINGS_DIR"] = root;
});

afterEach(() => {
  if (sessionsEnvBackup === undefined) {
    delete process.env["PIVIS_SESSIONS_DIR"];
  } else {
    process.env["PIVIS_SESSIONS_DIR"] = sessionsEnvBackup;
  }
  if (settingsEnvBackup === undefined) {
    delete process.env["PIVIS_SETTINGS_DIR"];
  } else {
    process.env["PIVIS_SETTINGS_DIR"] = settingsEnvBackup;
  }
  fs.rmSync(root, { recursive: true, force: true });
});

function writeSession(workspace: string, fileName: string, lines: object[]): string {
  const dir = path.join(root, workspace);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, fileName);
  fs.writeFileSync(filePath, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
  return filePath;
}

// Helpers that build entries in the REAL pi v3 nested shape.
function userEntry(id: string, parentId: string, text: string) {
  return {
    id,
    parentId,
    timestamp: "2024-01-01T00:00:00Z",
    type: "message",
    message: { role: "user", content: [{ type: "text", text }], timestamp: 1_700_000_000_000 },
  };
}
function sessionInfo(id: string, parentId: string, name: string) {
  return { id, parentId, timestamp: "2024-01-01T00:00:00Z", type: "session_info", name };
}

describe("listSessionsForWorkspace", () => {
  it("returns the last session_info name in file order", async () => {
    const cwd = path.join(root, "workspace-A");
    const filePath = writeSession("workspace-A", "session1.jsonl", [
      { type: "session", version: 3, id: "abc", timestamp: "2024-01-01T00:00:00Z", cwd },
      userEntry("e1", "abc", "hello"),
      sessionInfo("e2", "e1", "First"),
      sessionInfo("e3", "e2", "Second"),
    ]);

    const summaries = await listSessionsForWorkspace(cwd);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.name).toBe("Second");
    expect(summaries[0]?.preview).toBe("hello");
    expect(summaries[0]?.messageCount).toBe(1);
    expect(summaries[0]?.filePath).toBe(filePath);
  });

  it("returns no name when the file has no session_info entries", async () => {
    const cwd = path.join(root, "workspace-A");
    writeSession("workspace-A", "session1.jsonl", [
      { type: "session", version: 3, id: "abc", timestamp: "2024-01-01T00:00:00Z", cwd },
      userEntry("e1", "abc", "hi"),
    ]);

    const summaries = await listSessionsForWorkspace(cwd);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.name).toBeUndefined();
    expect(summaries[0]?.messageCount).toBe(1);
  });

  it("samples large session files without losing head preview or tail name", async () => {
    const cwd = path.join(root, "workspace-A");
    const filePath = writeSession("workspace-A", "large.jsonl", [
      { type: "session", version: 3, id: "large", timestamp: "2024-01-01T00:00:00Z", cwd },
      userEntry("e1", "large", "head-preview"),
    ]);
    const filler = JSON.stringify({ type: "tool_result", data: "x".repeat(1024) });
    fs.appendFileSync(filePath, `${Array.from({ length: 1200 }, () => filler).join("\n")}\n`);
    fs.appendFileSync(filePath, `${JSON.stringify(sessionInfo("tail", "e1", "Tail Name"))}\n`);

    const summaries = await listSessionsForWorkspace(cwd);

    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.preview).toBe("head-preview");
    expect(summaries[0]?.name).toBe("Tail Name");
  });

  it("invalidates the cache when the file is rewritten with a new name", async () => {
    const cwd = path.join(root, "workspace-A");
    const filePath = writeSession("workspace-A", "session1.jsonl", [
      { type: "session", version: 3, id: "abc", timestamp: "2024-01-01T00:00:00Z", cwd },
      userEntry("e1", "abc", "hi"),
      sessionInfo("e2", "e1", "Initial"),
    ]);

    const first = await listSessionsForWorkspace(cwd);
    expect(first[0]?.name).toBe("Initial");

    fs.appendFileSync(
      filePath,
      `${JSON.stringify({
        id: "e3",
        parentId: "e2",
        timestamp: "2024-01-01T00:00:01Z",
        type: "session_info",
        name: "Third",
      })}\n`,
    );
    const future = new Date(Date.now() + 5000);
    fs.utimesSync(filePath, future, future);

    const second = await listSessionsForWorkspace(cwd);
    expect(second[0]?.name).toBe("Third");
  });

  it("does not return sessions whose header cwd differs from the queried workspace", async () => {
    const otherCwd = path.join(root, "workspace-B");
    fs.mkdirSync(path.join(root, "workspace-B"), { recursive: true });
    writeSession("workspace-B", "session1.jsonl", [
      { type: "session", version: 3, id: "abc", timestamp: "2024-01-01T00:00:00Z", cwd: otherCwd },
      userEntry("e1", "abc", "nope"),
      sessionInfo("e2", "e1", "Other"),
    ]);

    const summaries = await listSessionsForWorkspace(path.join(root, "workspace-A"));
    expect(summaries).toHaveLength(0);
  });

  it("extractSessionMeta ignores empty-string session_info names", () => {
    const cwd = path.join(root, "workspace-A");
    const filePath = writeSession("workspace-A", "session1.jsonl", [
      { type: "session", version: 3, id: "abc", timestamp: "2024-01-01T00:00:00Z", cwd },
      userEntry("e1", "abc", "hi"),
      sessionInfo("e2", "e1", "First"),
      {
        id: "e3",
        parentId: "e2",
        timestamp: "2024-01-01T00:00:01Z",
        type: "session_info",
        name: "",
      },
    ]);

    const meta = extractSessionMeta(filePath);
    expect(meta.name).toBe("First");
    expect(meta.preview).toBe("hi");
    expect(meta.messageCount).toBe(1);
  });

  it("extractSessionMeta reads user message from the real nested shape (not top-level role)", () => {
    const cwd = path.join(root, "workspace-A");
    const filePath = writeSession("workspace-A", "session1.jsonl", [
      { type: "session", version: 3, id: "abc", timestamp: "2024-01-01T00:00:00Z", cwd },
      userEntry("e1", "abc", "real-shape-here"),
    ]);
    const meta = extractSessionMeta(filePath);
    expect(meta.preview).toBe("real-shape-here");
    expect(meta.messageCount).toBe(1);
  });

  it("old flat shape (top-level role) yields messageCount === 0", () => {
    // Pins the read path: real pi never writes the flat shape, so this is
    // a regression guard. If a future change accidentally read top-level
    // role again, this test fails.
    const cwd = path.join(root, "workspace-A");
    const filePath = writeSession("workspace-A", "session1.jsonl", [
      { type: "session", version: 3, id: "abc", timestamp: "2024-01-01T00:00:00Z", cwd },
      {
        id: "e1",
        parentId: "abc",
        timestamp: "2024-01-01T00:00:00Z",
        type: "message",
        role: "user",
        content: [{ type: "text", text: "FLAT" }],
      },
    ]);
    const meta = extractSessionMeta(filePath);
    expect(meta.messageCount).toBe(0);
    expect(meta.preview).toBe("");
  });

  it("extractSessionMeta reports lastActiveAt as the newest user-message timestamp", () => {
    const cwd = path.join(root, "workspace-A");
    const filePath = writeSession("workspace-A", "session1.jsonl", [
      { type: "session", version: 3, id: "abc", timestamp: "2024-01-01T00:00:00Z", cwd },
      // older user message
      {
        id: "e1",
        parentId: "abc",
        timestamp: "2024-01-01T00:00:00Z",
        type: "message",
        message: {
          role: "user",
          content: [{ type: "text", text: "first" }],
          timestamp: 1_700_000_000_000,
        },
      },
      // a later session_info entry — must NOT count as activity (passive open)
      {
        id: "e2",
        parentId: "e1",
        timestamp: "2024-06-01T00:00:00Z",
        type: "session_info",
        name: "Glanced",
      },
      // newest user message — this is the activity we want
      {
        id: "e3",
        parentId: "e2",
        timestamp: "2024-02-01T00:00:00Z",
        type: "message",
        message: {
          role: "user",
          content: [{ type: "text", text: "second" }],
          timestamp: 1_700_000_001_000,
        },
      },
    ]);
    const meta = extractSessionMeta(filePath);
    // Newest user message is e3 at 2024-02-01 (1706745600000). The later
    // session_info entry (e2, 2024-06-01) must NOT count as activity.
    expect(meta.lastActiveAt).toBe(Date.parse("2024-02-01T00:00:00Z"));
  });

  it("extractSessionMeta returns null lastActiveAt when there are no user messages", () => {
    const cwd = path.join(root, "workspace-A");
    const filePath = writeSession("workspace-A", "session1.jsonl", [
      { type: "session", version: 3, id: "abc", timestamp: "2024-01-01T00:00:00Z", cwd },
      {
        id: "e1",
        parentId: "abc",
        timestamp: "2024-01-01T00:00:00Z",
        type: "session_info",
        name: "Empty",
      },
    ]);
    const meta = extractSessionMeta(filePath);
    expect(meta.lastActiveAt).toBeNull();
  });

  it("orders sessions by last user activity, not file mtime (passive open must not promote)", async () => {
    const cwd = path.join(root, "workspace-A");
    // Session A: actively worked in recently (user message at 2024-02-01),
    // but its file mtime is old.
    const filePathA = writeSession("workspace-A", "active.jsonl", [
      { type: "session", version: 3, id: "A", timestamp: "2024-01-01T00:00:00Z", cwd },
      {
        id: "a1",
        parentId: "A",
        timestamp: "2024-02-01T00:00:00Z",
        type: "message",
        message: {
          role: "user",
          content: [{ type: "text", text: "real work" }],
          timestamp: 1_700_000_001_000,
        },
      },
    ]);
    // Session B: only glanced at (a passive open appended a fresh
    // session_info), so its file mtime is the newest of the two even though
    // the last real user activity is older.
    const filePathB = writeSession("workspace-A", "glanced.jsonl", [
      { type: "session", version: 3, id: "B", timestamp: "2024-01-01T00:00:00Z", cwd },
      {
        id: "b1",
        parentId: "B",
        timestamp: "2024-01-15T00:00:00Z",
        type: "message",
        message: {
          role: "user",
          content: [{ type: "text", text: "old work" }],
          timestamp: 1_700_000_000_000,
        },
      },
      {
        id: "b2",
        parentId: "b1",
        timestamp: "2024-12-01T00:00:00Z",
        type: "session_info",
        name: "Glanced",
      },
    ]);
    // Force B's file mtime to be newer than A's (simulating a passive open
    // touch), even though A's last user activity is newer.
    const oldMtime = new Date("2024-01-01T00:00:00Z");
    const newMtime = new Date("2024-12-01T00:00:00Z");
    fs.utimesSync(filePathA, oldMtime, oldMtime);
    fs.utimesSync(filePathB, newMtime, newMtime);

    const summaries = await listSessionsForWorkspace(cwd);
    expect(summaries).toHaveLength(2);
    // A (newer user activity) must rank above B (newer mtime only).
    expect(summaries[0]?.id).toBe("A");
    expect(summaries[1]?.id).toBe("B");
  });
});

describe("worktree session discovery", () => {
  function writeHeader(cwd: string, id: string): string {
    // Session files live in a subdirectory of SESSIONS_DIR (the discovery
    // scanner only descends into subdirs, not loose files at the root).
    const dir = path.join(root, "wt-files");
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, `${id}.jsonl`);
    const header = JSON.stringify({
      type: "session",
      version: 3,
      id,
      timestamp: "2024-01-01T00:00:00Z",
      cwd,
    });
    fs.writeFileSync(filePath, `${header}\n`, "utf8");
    return filePath;
  }

  it("lists worktree-cwd sessions under their parent workspace", async () => {
    const workspace = path.join(root, "workspace-A");
    const worktreePath = path.join(root, "ws-A-worktrees", "swift-otter");
    fs.mkdirSync(worktreePath, { recursive: true });
    saveSettings({
      worktrees: {
        [worktreePath]: {
          workspacePath: workspace,
          branch: "pi-vis-swift-otter",
          name: "swift-otter",
          base: "main",
        },
      },
    });

    writeHeader(worktreePath, "wt-session");

    const summaries = await listSessionsForWorkspace(workspace);
    expect(summaries.some((s) => s.filePath.endsWith("wt-session.jsonl"))).toBe(true);
  });

  it("does NOT list a worktree session under an unrelated workspace", async () => {
    const workspaceA = path.join(root, "workspace-A");
    const workspaceB = path.join(root, "workspace-B");
    fs.mkdirSync(workspaceB, { recursive: true });
    const worktreePath = path.join(root, "wt");
    fs.mkdirSync(worktreePath, { recursive: true });
    saveSettings({
      worktrees: {
        [worktreePath]: { workspacePath: workspaceA, branch: "pi-vis-x", name: "x", base: "main" },
      },
    });

    writeHeader(worktreePath, "wt-only");

    const summariesB = await listSessionsForWorkspace(workspaceB);
    expect(summariesB.some((s) => s.filePath.endsWith("wt-only.jsonl"))).toBe(false);
  });

  it("keeps listing a worktree session across repeated calls (cache-hit path)", async () => {
    const workspace = path.join(root, "workspace-A");
    const worktreePath = path.join(root, "wt-cached");
    fs.mkdirSync(worktreePath, { recursive: true });
    saveSettings({
      worktrees: {
        [worktreePath]: { workspacePath: workspace, branch: "pi-vis-c", name: "c", base: "main" },
      },
    });

    writeHeader(worktreePath, "wt-cached-session");

    const first = await listSessionsForWorkspace(workspace);
    const second = await listSessionsForWorkspace(workspace);
    expect(first.some((s) => s.filePath.endsWith("wt-cached-session.jsonl"))).toBe(true);
    expect(second.some((s) => s.filePath.endsWith("wt-cached-session.jsonl"))).toBe(true);
  });

  it("resolveWorktreeForFile returns identity for a known worktree session", () => {
    const workspace = path.join(root, "workspace-A");
    const worktreePath = path.join(root, "wt-real");
    fs.mkdirSync(worktreePath, { recursive: true });
    saveSettings({
      worktrees: {
        [worktreePath]: {
          workspacePath: workspace,
          branch: "pi-vis-swift-otter",
          name: "swift-otter",
          base: "main",
        },
      },
    });

    const filePath = writeHeader(worktreePath, "wt-resolve");
    const identity = resolveWorktreeForFile(filePath, workspace);
    expect(identity).toEqual({
      path: worktreePath,
      branch: "pi-vis-swift-otter",
      name: "swift-otter",
      base: "main",
    });
  });

  it("resolveWorktreeForFile returns undefined when the worktree dir is gone", () => {
    const workspace = path.join(root, "workspace-A");
    const worktreePath = path.join(root, "wt-gone"); // never mkdir'd → missing
    saveSettings({
      worktrees: {
        [worktreePath]: {
          workspacePath: workspace,
          branch: "pi-vis-gone",
          name: "gone",
          base: "main",
        },
      },
    });

    const filePath = writeHeader(worktreePath, "wt-missing");
    expect(resolveWorktreeForFile(filePath, workspace)).toBeUndefined();
  });

  it("resolveWorktreeForFile returns undefined for a plain workspace session", () => {
    const workspace = path.join(root, "workspace-A");
    const filePath = writeHeader(workspace, "plain-session");
    expect(resolveWorktreeForFile(filePath, workspace)).toBeUndefined();
  });
});
