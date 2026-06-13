import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { extractSessionMeta, listSessionsForWorkspace } from "./session-discovery.js";

let root: string;
let envBackup: string | undefined;

beforeEach(() => {
  envBackup = process.env["PIVIS_SESSIONS_DIR"];
  root = fs.mkdtempSync(path.join(os.tmpdir(), "pivis-discovery-"));
  process.env["PIVIS_SESSIONS_DIR"] = root;
  fs.mkdirSync(path.join(root, "workspace-A"), { recursive: true });
});

afterEach(() => {
  if (envBackup === undefined) {
    delete process.env["PIVIS_SESSIONS_DIR"];
  } else {
    process.env["PIVIS_SESSIONS_DIR"] = envBackup;
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
});
