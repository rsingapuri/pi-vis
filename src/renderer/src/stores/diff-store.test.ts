// Vitest suite for the diff-store inline edit session: open/save/freeze/conflict.
//
// We mock `window.pivis.invoke` with a stateful "disk" so the CAS protocol is
// exercised end to end (hash compare → ok / conflict → re-fetch → retry once).

import { createHash } from "node:crypto";
import type { GitWriteFileResult } from "@shared/git.js";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildDiffModel, visibleLineIndices } from "../lib/diff/diff-model.js";
import { resolveEditRange } from "../lib/diff/edit-range.js";
import { getHighlighter } from "../lib/shiki.js";
import { useDiffStore } from "./diff-store.js";

/** sha256 hex of the UTF-8 of `s` — symmetric with the renderer's sha256Hex. */
function sha(s: string): string {
  return createHash("sha256").update(Buffer.from(s, "utf8")).digest("hex");
}

const FILE = "f.ts";

let disk = "";
let invoke: ReturnType<typeof vi.fn>;

function resetStore(diskText: string): void {
  resetStoreWithTexts("", diskText, "A");
}

function resetStoreWithTexts(oldText: string, newText: string, status: "A" | "M" = "M"): void {
  disk = newText;
  const model = buildDiffModel(oldText, disk);
  useDiffStore.setState({
    open: true,
    sessionId: "s1" as never,
    root: "/repo",
    phase: "ready",
    files: [
      {
        path: FILE,
        status,
        untracked: status === "A",
        insertions: 0,
        deletions: 0,
        binary: false,
      },
    ],
    selectedPath: FILE,
    workingTreeScope: "base",
    commitRange: null,
    editSession: null,
    fileState: new Map([
      [
        FILE,
        {
          status: "ready",
          model,
          gapState: model.kind === "ok" ? model.gaps.map(() => ({ top: 0, bottom: 0 })) : [],
          oldTokens: null,
          newTokens: null,
          oldText,
          newText: disk,
          collapsed: false,
        },
      ],
    ]),
  });
}

function makeInvoke(): ReturnType<typeof vi.fn> {
  return vi.fn(async (channel: string, args: Record<string, unknown> = {}) => {
    if (channel === "git.writeWorkingFile") {
      const a = args as { content: string; expectedHash: string };
      if (sha(disk) === a.expectedHash) {
        disk = a.content;
        const ok: GitWriteFileResult = { kind: "ok" };
        return ok;
      }
      const conflict: GitWriteFileResult = { kind: "conflict" };
      return conflict;
    }
    if (channel === "git.fileDiff") {
      return {
        kind: "ok",
        oldText: "",
        newText: disk,
        binary: false,
        tooLarge: false,
        oldMissingNewline: false,
        newMissingNewline: !disk.endsWith("\n"),
      };
    }
    if (channel === "git.changes") {
      return {
        kind: "ok",
        repoRoot: "/repo",
        files: [
          { path: FILE, status: "A", untracked: true, insertions: 0, deletions: 0, binary: false },
        ],
        truncated: false,
        fingerprint: sha(disk),
      };
    }
    return { kind: "ok" };
  });
}

/** Open an edit session over new-lines [startNewNo..endNewNo] and return it. */
function openOver(startIdx: number, endIdx: number): void {
  const fs = useDiffStore.getState().fileState.get(FILE)!;
  if (!fs.model || fs.model.kind !== "ok") throw new Error("no model");
  const visible = visibleLineIndices(fs.model, fs.gapState ?? []);
  const range = resolveEditRange(fs.model, visible, startIdx, endIdx, new Set());
  if (!range) throw new Error("range not editable");
  useDiffStore.getState().openEditSession(FILE, range);
}

/** Flush pending microtasks so the background post-save refresh settles. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe("diff-store render caps", () => {
  it("bumps a file render cap immutably and never lowers it", () => {
    const before = new Map([
      ["big.ts", { status: "ready" as const, collapsed: false, renderCap: 5_000 }],
    ]);
    useDiffStore.setState({ fileState: before });

    useDiffStore.getState().bumpRenderCap("big.ts", 7_500);
    const raised = useDiffStore.getState().fileState;
    expect(raised).not.toBe(before);
    expect(raised.get("big.ts")?.renderCap).toBe(7_500);

    useDiffStore.getState().bumpRenderCap("big.ts", 6_000);
    expect(useDiffStore.getState().fileState.get("big.ts")?.renderCap).toBe(7_500);
  });

  it("clamps render-cap bumps at the diff row safety ceiling", () => {
    useDiffStore.setState({
      fileState: new Map([["huge.ts", { status: "ready" as const, collapsed: false }]]),
    });

    useDiffStore.getState().bumpRenderCap("huge.ts", 1_000_000);

    expect(useDiffStore.getState().fileState.get("huge.ts")?.renderCap).toBe(10_000);
  });
});

describe("diff-store base branch selection", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    invoke = vi.fn(async (channel: string) => {
      if (channel === "git.changes") {
        return {
          kind: "ok",
          repoRoot: "/repo",
          files: [],
          truncated: false,
          fingerprint: "clean",
        };
      }
      if (channel === "git.branches") {
        return {
          kind: "ok",
          current: "feature",
          branches: [
            { name: "feature", remote: false, current: true },
            { name: "main", remote: false, current: false },
          ],
        };
      }
      return { kind: "ok" };
    });
    vi.stubGlobal("window", { pivis: { invoke } });
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("remembers the selected base branch for the same session", () => {
    const store = useDiffStore.getState();
    store.openViewer("s-base-1" as never, "/repo");
    store.setBase("main");
    expect(useDiffStore.getState().selectedBase).toBe("main");

    store.closeViewer();
    useDiffStore.getState().openViewer("s-base-1" as never, "/repo");
    expect(useDiffStore.getState().selectedBase).toBe("main");

    useDiffStore.getState().openViewer("s-base-2" as never, "/repo");
    expect(useDiffStore.getState().selectedBase).toBeNull();
  });

  it("clears a remembered base branch that no longer exists", async () => {
    const store = useDiffStore.getState();
    store.openViewer("s-stale-base" as never, "/repo");
    store.setBase("deleted-branch");
    expect(useDiffStore.getState().selectedBase).toBe("deleted-branch");

    store.closeViewer();
    useDiffStore.getState().openViewer("s-stale-base" as never, "/repo");
    await Promise.resolve();

    expect(useDiffStore.getState().selectedBase).toBeNull();
  });

  it("ignores stale branch responses after switching viewers", async () => {
    let resolveRepoA!: (value: unknown) => void;
    const repoABranches = new Promise((resolve) => {
      resolveRepoA = resolve;
    });
    invoke.mockImplementation(async (channel: string, args: { root?: string } = {}) => {
      if (channel === "git.branches" && args.root === "/repo-a") return repoABranches;
      if (channel === "git.branches") {
        return {
          kind: "ok",
          current: "feature",
          branches: [
            { name: "feature", remote: false, current: true },
            { name: "keep", remote: false, current: false },
          ],
        };
      }
      if (channel === "git.changes") {
        return {
          kind: "ok",
          repoRoot: args.root ?? "/repo-b",
          files: [],
          truncated: false,
          fingerprint: "clean",
        };
      }
      return { kind: "ok" };
    });

    useDiffStore.setState({
      root: "/repo-a",
      sessionId: "session-a" as never,
      selectedBase: "main",
    });
    const staleLoad = useDiffStore.getState().loadBranches();
    useDiffStore.setState({
      root: "/repo-b",
      sessionId: "session-b" as never,
      selectedBase: "keep",
    });

    resolveRepoA({
      kind: "ok",
      current: "main",
      branches: [{ name: "main", remote: false, current: true }],
    });
    await staleLoad;

    expect(useDiffStore.getState().root).toBe("/repo-b");
    expect(useDiffStore.getState().sessionId).toBe("session-b");
    expect(useDiffStore.getState().selectedBase).toBe("keep");
  });
});

describe("diff-store commit ranges", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    invoke = vi.fn(async (channel: string) => {
      if (channel === "git.changes") {
        return {
          kind: "ok",
          repoRoot: "/repo",
          files: [],
          truncated: false,
          fingerprint: "working-fingerprint",
        };
      }
      if (channel === "git.branches") {
        return {
          kind: "ok",
          current: "feature",
          branches: [
            { name: "feature", remote: false, current: true },
            { name: "main", remote: false, current: false },
          ],
        };
      }
      return { kind: "ok" };
    });
    vi.stubGlobal("window", { pivis: { invoke } });
    useDiffStore.setState({
      open: true,
      sessionId: "range-session" as never,
      root: "/repo",
      selectedBase: "main",
      workingTreeScope: "base",
      commitRange: null,
      historicalContext: null,
      files: [],
      searchFiles: [],
      fileState: new Map(),
      editSession: null,
      stale: false,
      baselineFingerprint: null,
      search: { open: true, query: "needle", caseSensitive: false, activeMatch: null },
    });
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("keeps a clean viewer ready while refreshing", async () => {
    useDiffStore.setState({ phase: "ready", files: [], searchFiles: [], fileState: new Map() });

    const refresh = useDiffStore.getState().refresh();

    // An empty FileState means the repository is clean, not that this is the
    // initial load. Keeping this ready preserves the diff rail and shell.
    expect(useDiffStore.getState().phase).toBe("ready");
    await Promise.resolve();
    vi.advanceTimersByTime(800);
    await refresh;
  });

  it("resets a range on close/reopen while retaining the selected base", () => {
    const store = useDiffStore.getState();
    store.setBase("main");
    store.setCommitRange({ start: "a", end: "a" });
    store.closeViewer();
    store.openViewer("range-session" as never, "/repo");

    expect(useDiffStore.getState().selectedBase).toBe("main");
    expect(useDiffStore.getState().commitRange).toBeNull();
  });

  it("setBase clears the selected commit range", () => {
    useDiffStore.setState({ commitRange: { start: "a", end: "b" } });

    useDiffStore.getState().setBase("feature");

    expect(useDiffStore.getState().selectedBase).toBe("feature");
    expect(useDiffStore.getState().commitRange).toBeNull();
  });

  it("keeps the selected base visible while requesting uncommitted-only changes from HEAD", () => {
    useDiffStore.getState().showUncommittedChanges();

    expect(useDiffStore.getState()).toMatchObject({
      selectedBase: "main",
      workingTreeScope: "uncommitted",
      commitRange: null,
    });
    const changesCall = invoke.mock.calls.find((call) => call[0] === "git.changes");
    expect(changesCall?.[1]).toEqual({ root: "/repo" });
  });

  it("does not change comparison while an unsaved comment editor is open", () => {
    useDiffStore.getState().setCommentEditorOpen(FILE, true);

    useDiffStore.getState().setBase("feature");
    useDiffStore.getState().setCommitRange({ start: "a", end: "b" });

    expect(useDiffStore.getState().selectedBase).toBe("main");
    expect(useDiffStore.getState().commitRange).toBeNull();
    expect(invoke.mock.calls.filter((call) => call[0] === "git.changes")).toHaveLength(0);
    useDiffStore.getState().setCommentEditorOpen(FILE, false);
  });

  it("atomically changes base and range with one refresh, and ignores an equal comparison", () => {
    useDiffStore.getState().setComparison({
      base: "feature",
      range: { start: "a", end: "b" },
    });
    expect(useDiffStore.getState().selectedBase).toBe("feature");
    expect(useDiffStore.getState().commitRange).toEqual({ start: "a", end: "b" });
    expect(invoke.mock.calls.filter((call) => call[0] === "git.changes")).toHaveLength(1);

    useDiffStore.getState().setComparison({
      base: "feature",
      range: { start: "a", end: "b" },
    });
    expect(invoke.mock.calls.filter((call) => call[0] === "git.changes")).toHaveLength(1);
  });

  it("does not allow an unresolved old-range file diff to populate after changing range", async () => {
    let resolveFileDiff!: (value: unknown) => void;
    const oldFileDiff = new Promise((resolve) => {
      resolveFileDiff = resolve;
    });
    const file = {
      path: FILE,
      status: "A" as const,
      untracked: true,
      insertions: 1,
      deletions: 0,
      binary: false,
    };
    invoke.mockImplementation(async (channel: string) => {
      if (channel === "git.fileDiff") return oldFileDiff;
      if (channel === "git.changes") {
        return { kind: "ok", repoRoot: "/repo", files: [file], truncated: false, fingerprint: "x" };
      }
      return { kind: "ok" };
    });
    useDiffStore.setState({
      files: [file],
      searchFiles: [file],
      fileState: new Map([[FILE, { status: "idle", collapsed: false }]]),
      commitRange: { start: "old", end: "old" },
    });

    const oldLoad = useDiffStore.getState().ensureFileLoaded(FILE);
    useDiffStore.getState().setCommitRange({ start: "new", end: "new" });
    resolveFileDiff({
      kind: "ok",
      oldText: "",
      newText: "old range",
      binary: false,
      tooLarge: false,
      oldMissingNewline: false,
      newMissingNewline: false,
    });
    await oldLoad;

    expect(useDiffStore.getState().fileState.get(FILE)?.newText).not.toBe("old range");
  });

  it("refuses editing historical comparisons", () => {
    resetStore("a\nb\n");
    useDiffStore.setState({ commitRange: { start: "a", end: "a" } });

    openOver(0, 0);

    expect(useDiffStore.getState().editSession).toBeNull();
  });

  it("forwards the manifest's immutable context to lazy historical reads", async () => {
    const range = { start: "a".repeat(40), end: "b".repeat(40) };
    const historicalContext = { parent: "c".repeat(40), end: range.end };
    const file = {
      path: FILE,
      status: "A" as const,
      untracked: false,
      insertions: 1,
      deletions: 0,
      binary: true,
    };
    invoke.mockImplementation(async (channel: string) => {
      if (channel === "git.changes") {
        return {
          kind: "ok",
          repoRoot: "/repo",
          files: [file],
          searchFiles: [file],
          historicalContext,
          truncated: false,
          fingerprint: "immutable",
        };
      }
      if (channel === "git.fileDiff") {
        return {
          kind: "ok",
          oldText: "",
          newText: "historical\n",
          binary: true,
          tooLarge: false,
          oldMissingNewline: false,
          newMissingNewline: false,
        };
      }
      return { kind: "ok" };
    });
    useDiffStore.setState({ commitRange: range });

    const refresh = useDiffStore.getState().refresh();
    await Promise.resolve();
    vi.advanceTimersByTime(800);
    await refresh;
    await useDiffStore.getState().ensureFileLoaded(FILE);
    const secondRefresh = useDiffStore.getState().refresh();
    await Promise.resolve();
    vi.advanceTimersByTime(800);
    await secondRefresh;

    expect(invoke).toHaveBeenCalledWith(
      "git.changes",
      expect.objectContaining({ range, historicalContext }),
    );
    expect(invoke).toHaveBeenCalledWith(
      "git.fileDiff",
      expect.objectContaining({ range, historicalContext }),
    );
  });

  it("historical refresh clears the working-tree baseline and stale indicator", async () => {
    useDiffStore.setState({
      commitRange: { start: "a", end: "b" },
      stale: true,
      baselineFingerprint: "old-working-baseline",
    });

    const refresh = useDiffStore.getState().refresh();
    await Promise.resolve();
    vi.advanceTimersByTime(800);
    await refresh;

    expect(useDiffStore.getState().baselineFingerprint).toBeNull();
    expect(useDiffStore.getState().stale).toBe(false);
  });
});

describe("diff-store edit session", () => {
  beforeAll(async () => {
    // Warm the Shiki singleton under real timers so commitSave's tokenizeLines
    // resolves without timer-dependent init under fake timers.
    await getHighlighter();
  });

  beforeEach(() => {
    vi.useFakeTimers();
    invoke = makeInvoke();
    vi.stubGlobal("window", { pivis: { invoke } });
    resetStore("a\nb\nc\nd\n");
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("opens an edit session for an editable selection", () => {
    openOver(1, 2); // new-lines 2..3 ("b","c")
    const s = useDiffStore.getState().editSession;
    expect(s).not.toBeNull();
    expect(s!.path).toBe(FILE);
    expect(s!.startNewNo).toBe(2);
    expect(s!.endNewNo).toBe(3);
    expect(s!.phase).toBe("editing");
  });

  it("refuses to open a second session while one is open", () => {
    openOver(1, 1);
    const first = useDiffStore.getState().editSession;
    openOver(2, 2); // no-op
    expect(useDiffStore.getState().editSession).toBe(first);
  });

  it("saves: splices, writes to disk, commits FileState in one set, clears session", async () => {
    openOver(1, 2); // replace new-lines 2..3 ("b","c") with ["X","Y"]
    await useDiffStore.getState().saveEditSession(["X\nY"]);
    await flush();

    expect(disk).toBe("a\nX\nY\nd\n");
    expect(useDiffStore.getState().editSession).toBeNull();
    expect(useDiffStore.getState().fileState.get(FILE)?.newText).toBe("a\nX\nY\nd\n");
    expect(useDiffStore.getState().fileState.get(FILE)?.model?.kind).toBe("ok");
  });

  it("can delete all editable lines across an interior removal without leaving a blank line", async () => {
    resetStoreWithTexts("top\nremove\nmiddle\nbottom\n", "top\nmiddle\nbottom\n");
    const fs = useDiffStore.getState().fileState.get(FILE)!;
    if (!fs.model || fs.model.kind !== "ok") throw new Error("no model");
    const topIdx = fs.model.lines.findIndex((ln) => ln.type === "context" && ln.text === "top");
    const middleIdx = fs.model.lines.findIndex(
      (ln) => ln.type === "context" && ln.text === "middle",
    );
    openOver(topIdx, middleIdx); // selection includes the removed "remove" row in between
    expect(useDiffStore.getState().editSession?.blocks).toEqual([
      { kind: "edit", lineIdxs: [topIdx, middleIdx], newNos: [1, 2], initialText: "top\nmiddle" },
    ]);

    await useDiffStore.getState().saveEditSession([""]);
    await flush();

    expect(disk).toBe("bottom\n");
  });

  it("sends the CAS expectedHash derived from the base newText", async () => {
    openOver(1, 1);
    await useDiffStore.getState().saveEditSession(["Z"]);
    const call = invoke.mock.calls.find((c) => c[0] === "git.writeWorkingFile");
    expect(call?.[1]?.expectedHash).toBe(sha("a\nb\nc\nd\n"));
  });

  it("conflict → re-anchors the original block and retries once → ok", async () => {
    openOver(1, 2); // original block ["b","c"]
    // Disk changes elsewhere (line 4 d→D) so the base hash mismatches, but the
    // ["b","c"] block still appears uniquely → re-anchor + retry succeeds.
    disk = "a\nb\nc\nD\n";
    await useDiffStore.getState().saveEditSession(["X\nY"]);
    await flush();

    expect(disk).toBe("a\nX\nY\nD\n");
    expect(useDiffStore.getState().editSession).toBeNull();
    // Exactly one initial write + one retry.
    const writes = invoke.mock.calls.filter((c) => c[0] === "git.writeWorkingFile");
    expect(writes.length).toBe(2);
  });

  it("conflict with an ambiguous original block → conflict phase (no infinite retry)", async () => {
    openOver(1, 2); // original block ["b","c"]
    // Disk now contains ["b","c"] twice → findUniqueBlock returns null.
    disk = "a\nb\nc\nb\nc\n";
    await useDiffStore.getState().saveEditSession(["X\nY"]);
    await flush();

    const s = useDiffStore.getState().editSession;
    expect(s?.phase).toBe("conflict");
    // Disk untouched by the failed save.
    expect(disk).toBe("a\nb\nc\nb\nc\n");
    // Only the initial conflicting write — no retry when the block is ambiguous.
    const writes = invoke.mock.calls.filter((c) => c[0] === "git.writeWorkingFile");
    expect(writes.length).toBe(1);
  });

  it("a write error surfaces an error phase with the message", async () => {
    openOver(1, 1);
    invoke.mockImplementationOnce(async () => ({ kind: "error", message: "disk full" }));
    await useDiffStore.getState().saveEditSession(["Z"]);
    await flush();
    const s = useDiffStore.getState().editSession;
    expect(s?.phase).toBe("error");
    expect(s?.errorMessage).toBe("disk full");
  });

  it("does not reload a frozen file while an edit session is open", async () => {
    openOver(1, 1);
    invoke.mockClear();
    await useDiffStore.getState().ensureFileLoaded(FILE);
    // ensureFileLoaded early-returns for the frozen file → no git.fileDiff.
    expect(invoke).not.toHaveBeenCalled();
  });

  it("keeps frozen FileState when the edited file vanishes from git.changes", async () => {
    openOver(1, 1);
    const beforeState = useDiffStore.getState().fileState.get(FILE);
    invoke.mockImplementation(async (channel: string) => {
      if (channel === "git.changes") {
        return {
          kind: "ok",
          repoRoot: "/repo",
          files: [],
          truncated: false,
          fingerprint: "clean",
        };
      }
      return { kind: "ok" };
    });

    const refresh = useDiffStore.getState().refresh();
    await Promise.resolve();
    vi.advanceTimersByTime(800);
    await refresh;

    expect(useDiffStore.getState().files.some((f) => f.path === FILE)).toBe(true);
    expect(useDiffStore.getState().fileState.get(FILE)).toBe(beforeState);
    expect(useDiffStore.getState().editSession?.queuedRefresh).toBe(true);
  });

  it("cancelEditSession closes the session (no save)", () => {
    openOver(1, 1);
    useDiffStore.getState().cancelEditSession();
    expect(useDiffStore.getState().editSession).toBeNull();
    // Disk untouched.
    expect(disk).toBe("a\nb\nc\nd\n");
  });

  it("requestCancelEdit is ignored while a save is in flight", () => {
    openOver(1, 1);
    const session = useDiffStore.getState().editSession;
    expect(session).not.toBeNull();
    useDiffStore.setState({ editSession: { ...session!, phase: "saving" } });

    useDiffStore.getState().requestCancelEdit();

    expect(useDiffStore.getState().editCancelNonce).toBe(0);
    expect(useDiffStore.getState().editSession?.phase).toBe("saving");
  });

  it("viewer close/open clears any inline edit session and stale cancel nonce", () => {
    openOver(1, 1);
    useDiffStore.getState().requestCancelEdit();
    expect(useDiffStore.getState().editSession).not.toBeNull();
    expect(useDiffStore.getState().editCancelNonce).toBeGreaterThan(0);

    useDiffStore.getState().closeViewer();
    expect(useDiffStore.getState().editSession).toBeNull();
    expect(useDiffStore.getState().editCancelNonce).toBe(0);

    resetStore("a\nb\nc\nd\n");
    openOver(1, 1);
    useDiffStore.getState().openViewer("s1" as never, "/repo");
    expect(useDiffStore.getState().editSession).toBeNull();
    expect(useDiffStore.getState().editCancelNonce).toBe(0);
  });
});
