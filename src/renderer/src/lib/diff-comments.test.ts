import type { SessionId } from "@shared/ids.js";
import { afterEach, describe, expect, it } from "vitest";
import type { CodeComment } from "./diff-comments.js";
import {
  DIFF_COMMENTS_STORAGE_KEY,
  formatCodeCommentsMarkdown,
  loadPersistedCodeComments,
  persistCodeComments,
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
