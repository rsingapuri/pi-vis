import type { SessionId } from "@shared/ids.js";
import { afterEach, describe, expect, it } from "vitest";
import type { CodeComment } from "./diff-comments.js";
import {
  DIFF_COMMENTS_STORAGE_KEY,
  UNIFIED_COMMENT_CUSTODY_STORAGE_KEY,
  formatCodeCommentsMarkdown,
  loadPersistedCodeComments,
  loadUnifiedCommentCustodies,
  persistCodeComments,
  persistUnifiedCommentCustodies,
  prependCodeCommentsToPrompt,
  sortCodeComments,
} from "./diff-comments.js";

class MemoryStorage implements Storage {
  private values = new Map<string, string>();
  get length(): number {
    return this.values.size;
  }
  clear(): void {
    this.values.clear();
  }
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  key(index: number): string | null {
    return Array.from(this.values.keys())[index] ?? null;
  }
  removeItem(key: string): void {
    this.values.delete(key);
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

const originalWindow = (globalThis as { window?: unknown }).window;

afterEach(() => {
  if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window;
  else (globalThis as { window: unknown }).window = originalWindow;
});

function installStorage(): MemoryStorage {
  const localStorage = new MemoryStorage();
  (globalThis as { window: unknown }).window = {
    document: {},
    localStorage,
    sessionStorage: new MemoryStorage(),
  };
  return localStorage;
}

function comment(
  fields: Partial<CodeComment> & Pick<CodeComment, "filePath" | "lineNumber" | "text">,
): CodeComment {
  return {
    id: `${fields.filePath}:${fields.lineNumber}`,
    originalLineNumber: fields.lineNumber,
    lineText: "const value = true;",
    anchorStatus: "current",
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
    ...fields,
  };
}

describe("diff comments", () => {
  it("sorts comments deterministically by file then line", () => {
    expect(
      sortCodeComments([
        comment({ filePath: "b.ts", lineNumber: 1, text: "second file" }),
        comment({ filePath: "a.ts", lineNumber: 20, text: "later" }),
        comment({ filePath: "a.ts", lineNumber: 3, text: "earlier" }),
      ]).map((c) => `${c.filePath}:${c.lineNumber}`),
    ).toEqual(["a.ts:3", "a.ts:20", "b.ts:1"]);
  });

  it("formats the markdown template with file, line, and line-text metadata", () => {
    expect(
      formatCodeCommentsMarkdown([
        comment({ filePath: "src/b.ts", lineNumber: 4, text: "Use the helper here." }),
        comment({ filePath: "src/a.ts", lineNumber: 2, text: "  Trim me.  " }),
      ]),
    ).toBe(
      [
        "### User comments on the code",
        "",
        "## Comment 1",
        "File: src/a.ts",
        "Line: 2",
        "Line text: const value = true;",
        "Trim me.",
        "",
        "## Comment 2",
        "File: src/b.ts",
        "Line: 4",
        "Line text: const value = true;",
        "Use the helper here.",
        "",
        "* * *",
      ].join("\n"),
    );
  });

  it("includes relocated/stale anchor metadata", () => {
    expect(
      formatCodeCommentsMarkdown([
        comment({
          filePath: "src/a.ts",
          lineNumber: 8,
          originalLineNumber: 3,
          anchorStatus: "relocated",
          text: "Moved with the line.",
        }),
      ]),
    ).toContain("Anchor: relocated from line 3");
  });

  it("prepends comments before the original prompt", () => {
    expect(
      prependCodeCommentsToPrompt("Please fix this.", [
        comment({ filePath: "src/a.ts", lineNumber: 2, text: "Needs a guard." }),
      ]),
    ).toContain("* * *\n\nPlease fix this.");
  });

  it("round-trips comments through localStorage", () => {
    const localStorage = installStorage();
    const sessionId = "session-a" as SessionId;
    const comments = new Map<SessionId, Map<string, CodeComment>>([
      [
        sessionId,
        new Map([
          [
            "src/a.ts\u00002",
            comment({ filePath: "src/a.ts", lineNumber: 2, text: "Needs a guard." }),
          ],
        ]),
      ],
    ]);

    persistCodeComments(comments);

    expect(localStorage.getItem(DIFF_COMMENTS_STORAGE_KEY)).toContain("Needs a guard.");
    expect(loadPersistedCodeComments().get(sessionId)?.get("src/a.ts\u00002")).toMatchObject({
      filePath: "src/a.ts",
      lineNumber: 2,
      text: "Needs a guard.",
    });
  });
});

describe("unified comment custody persistence", () => {
  it("round-trips exact comment revisions and durable empty tombstones", () => {
    const localStorage = installStorage();
    const original = comment({
      id: "comment-7",
      filePath: "src/a.ts",
      lineNumber: 7,
      text: "Keep this exact revision.",
      revision: 4,
      updatedAt: 9,
    });
    const requestKey = "session-a\u0000host-a\u00001\u0000request-a";
    const emptyRequestKey = "session-a\u0000host-a\u00001\u0000request-without-comments";

    expect(
      persistUnifiedCommentCustodies(
        new Map([
          [requestKey, [original]],
          [emptyRequestKey, []],
        ]),
      ),
    ).toBe(true);

    original.text = "mutated after persistence";
    const loaded = loadUnifiedCommentCustodies();
    expect(localStorage.getItem(UNIFIED_COMMENT_CUSTODY_STORAGE_KEY)).not.toContain(
      "mutated after persistence",
    );
    expect(loaded.get(requestKey)).toEqual([
      expect.objectContaining({
        id: "comment-7",
        filePath: "src/a.ts",
        lineNumber: 7,
        text: "Keep this exact revision.",
        revision: 4,
        updatedAt: 9,
      }),
    ]);
    expect(loaded.get(requestKey)?.[0]).not.toBe(original);
    expect(loaded.get(emptyRequestKey)).toEqual([]);
  });

  it("validates individual records while retaining array keys as tombstones", () => {
    const localStorage = installStorage();
    localStorage.setItem(
      UNIFIED_COMMENT_CUSTODY_STORAGE_KEY,
      JSON.stringify({
        valid: [
          {
            filePath: "src/valid.ts",
            lineNumber: 3,
            text: "Valid comment",
            anchorStatus: "unexpected",
          },
          null,
          { filePath: "", lineNumber: 3, text: "missing path" },
          { filePath: "src/bad-line.ts", lineNumber: 0, text: "bad line" },
          { filePath: "src/blank.ts", lineNumber: 2, text: "   " },
        ],
        allInvalid: [{ nope: true }],
        notAnArray: { filePath: "src/a.ts", lineNumber: 1, text: "ignored" },
      }),
    );

    const loaded = loadUnifiedCommentCustodies();
    expect(loaded.get("valid")).toEqual([
      expect.objectContaining({
        filePath: "src/valid.ts",
        lineNumber: 3,
        originalLineNumber: 3,
        lineText: "",
        anchorStatus: "current",
        text: "Valid comment",
        revision: 1,
      }),
    ]);
    expect(loaded.get("allInvalid")).toEqual([]);
    expect(loaded.has("notAnArray")).toBe(false);
  });

  it("fails closed for malformed or unavailable storage", () => {
    const localStorage = installStorage();
    localStorage.setItem(UNIFIED_COMMENT_CUSTODY_STORAGE_KEY, "{not-json");
    expect(loadUnifiedCommentCustodies()).toEqual(new Map());

    delete (globalThis as { window?: unknown }).window;
    expect(loadUnifiedCommentCustodies()).toEqual(new Map());
    expect(persistUnifiedCommentCustodies(new Map([["request", []]]))).toBe(false);

    (globalThis as { window: unknown }).window = { document: {} };
    Object.defineProperty((globalThis as { window: object }).window, "localStorage", {
      get() {
        throw new Error("storage denied");
      },
    });
    expect(loadUnifiedCommentCustodies()).toEqual(new Map());
    expect(persistUnifiedCommentCustodies(new Map([["request", []]]))).toBe(false);
  });

  it("reports storage write failures and removes storage for an empty bounded set", () => {
    const localStorage = installStorage();
    localStorage.setItem(UNIFIED_COMMENT_CUSTODY_STORAGE_KEY, "stale");
    expect(persistUnifiedCommentCustodies(new Map())).toBe(true);
    expect(localStorage.getItem(UNIFIED_COMMENT_CUSTODY_STORAGE_KEY)).toBeNull();

    const failingStorage = new MemoryStorage();
    failingStorage.setItem = () => {
      throw new Error("quota exceeded");
    };
    (globalThis as { window: unknown }).window = {
      document: {},
      localStorage: failingStorage,
      sessionStorage: new MemoryStorage(),
    };
    expect(persistUnifiedCommentCustodies(new Map([["request", []]]))).toBe(false);
  });

  it("preserves every entry in the caller-bounded custody set", () => {
    installStorage();
    const custodies = new Map<string, readonly CodeComment[]>();
    for (let index = 0; index < 512; index++) {
      custodies.set(
        `request-${index}`,
        index % 2 === 0
          ? []
          : [
              comment({
                filePath: `src/${index}.ts`,
                lineNumber: 1,
                text: `Comment ${index}`,
              }),
            ],
      );
    }

    expect(persistUnifiedCommentCustodies(custodies)).toBe(true);
    const loaded = loadUnifiedCommentCustodies();
    expect(loaded).toHaveLength(512);
    expect(loaded.get("request-0")).toEqual([]);
    expect(loaded.get("request-511")?.[0]?.text).toBe("Comment 511");
  });
});
