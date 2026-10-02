import fs from "node:fs";
import path from "node:path";

export interface SessionSearchCorpus {
  workspaceA: string;
  workspaceB: string;
  worktreeA: string;
  sessionsRoot: string;
  oldTargetFile: string;
  appendFile: string;
  archivedFile: string;
}

function row(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function writeSession(
  sessionsRoot: string,
  bucket: string,
  fileName: string,
  cwd: string,
  entries: unknown[],
): string {
  const directory = path.join(sessionsRoot, bucket);
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `${fileName}.jsonl`);
  fs.writeFileSync(
    file,
    row({
      type: "session",
      version: 3,
      id: fileName,
      timestamp: "2024-01-01T00:00:00.000Z",
      cwd,
    }) + entries.map(row).join(""),
  );
  return file;
}

export function generateSessionSearchCorpus(root: string): SessionSearchCorpus {
  const workspaceA = path.join(root, "workspace-alpha");
  const workspaceB = path.join(root, "workspace-beta");
  const worktreeA = path.join(root, "workspace-alpha-worktrees", "rustic-gnome");
  const sessionsRoot = path.join(root, "pi-sessions");
  fs.mkdirSync(workspaceA, { recursive: true });
  fs.mkdirSync(workspaceB, { recursive: true });
  fs.mkdirSync(worktreeA, { recursive: true });
  fs.mkdirSync(sessionsRoot, { recursive: true });

  // More than the sidebar page size. Their recent timestamps place the old
  // exact target below the first 30 visible rows.
  for (let index = 0; index < 34; index++) {
    writeSession(
      sessionsRoot,
      `recent-${String(index).padStart(2, "0")}`,
      `recent-a-${index}`,
      workspaceA,
      [
        {
          type: "session_info",
          id: `name-${index}`,
          timestamp: `2025-02-${String((index % 20) + 1).padStart(2, "0")}T00:00:00.000Z`,
          name: `Recent alpha ${index}`,
        },
        {
          type: "message",
          id: `user-${index}`,
          parentId: `name-${index}`,
          timestamp: `2025-02-${String((index % 20) + 1).padStart(2, "0")}T01:00:00.000Z`,
          message: { role: "user", content: `ordinary recent alpha material ${index}` },
        },
      ],
    );
  }

  const oldTargetFile = writeSession(sessionsRoot, "old-target", "old-exact-alpha", workspaceA, [
    {
      type: "session_info",
      id: "old-name",
      timestamp: "2024-01-01T00:00:01.000Z",
      name: "Ancient lifecycle investigation",
    },
    {
      type: "message",
      id: "old-root",
      parentId: "old-name",
      timestamp: "2024-01-01T00:00:02.000Z",
      message: { role: "user", content: "quartz precompaction lifecycle evidence" },
    },
    {
      type: "compaction",
      id: "compact",
      parentId: "old-root",
      timestamp: "2024-01-01T00:00:03.000Z",
      summary: "saved summary after quartz evidence",
      firstKeptEntryId: "old-root",
      tokensBefore: 500,
    },
    {
      type: "message",
      id: "alternate",
      parentId: "compact",
      timestamp: "2024-01-01T00:00:04.000Z",
      message: { role: "assistant", content: "juniper alternate-only branch evidence" },
    },
    {
      type: "message",
      id: "latest",
      parentId: "compact",
      timestamp: "2024-01-01T00:00:05.000Z",
      message: { role: "assistant", content: "latest persisted path material" },
    },
  ]);

  writeSession(sessionsRoot, "workspace-b", "beta-only", workspaceB, [
    { type: "session_info", id: "beta-name", name: "Beta secrets" },
    {
      type: "message",
      id: "beta-user",
      parentId: "beta-name",
      message: { role: "user", content: "zircon workspace beta only" },
    },
  ]);

  writeSession(sessionsRoot, "worktree-a", "alpha-worktree", worktreeA, [
    { type: "session_info", id: "wt-name", name: "Mapped worktree history" },
    {
      type: "message",
      id: "wt-user",
      parentId: "wt-name",
      message: { role: "user", content: "cobalt mapped worktree only" },
    },
  ]);

  const appendFile = writeSession(sessionsRoot, "append-a", "append-alpha", workspaceA, [
    { type: "session_info", id: "append-name", name: "Append target" },
    {
      type: "message",
      id: "append-root",
      parentId: "append-name",
      message: { role: "user", content: "initial append fixture" },
    },
  ]);

  const archivedFile = writeSession(sessionsRoot, "archived-a", "archived-alpha", workspaceA, [
    { type: "session_info", id: "archived-name", name: "Archived search target" },
    {
      type: "message",
      id: "archived-user",
      parentId: "archived-name",
      message: { role: "user", content: "topaz archived material must stay hidden" },
    },
  ]);

  // Malformed neighboring data and an incomplete final row must not hide the
  // valid preceding entry or become searchable themselves.
  const corrupt = writeSession(sessionsRoot, "corrupt-a", "corrupt-alpha", workspaceA, [
    {
      type: "message",
      id: "valid-before-corrupt",
      message: { role: "user", content: "onyx valid neighbor" },
    },
  ]);
  fs.appendFileSync(corrupt, "{ malformed row }\n");
  fs.appendFileSync(
    corrupt,
    JSON.stringify({
      type: "message",
      id: "incomplete",
      message: { role: "user", content: "incomplete hidden material" },
    }).slice(0, -1),
  );

  return {
    workspaceA,
    workspaceB,
    worktreeA,
    sessionsRoot,
    oldTargetFile,
    appendFile,
    archivedFile,
  };
}
