import type { FlatTreeNode, SessionTreeNode } from "@shared/pi-protocol/responses.js";
import { describe, expect, it } from "vitest";
import {
  type FlattenOpts,
  buildNestedTree,
  entryDisplayText,
  flattenVisible,
} from "./tree-flatten.js";

// A realistic tree: settings entries at the ROOT (as every real session has),
// a linear chain, then one branch point (u1 has two assistant children).
//
//   m1   model_change            (root, settings)
//   tl1  thinking_level_change   (settings)
//   si1  session_info            (settings)
//   u1   user "fix the loader"   ← branch point (2 children)
//   ├ a1   assistant "+ toolCall read"
//   │  tr1  toolResult(read)
//   │   a1d assistant "fixed with absolute paths"
//   └ a2   assistant "trying relative paths"   (active branch)
//      tr2  toolResult(read)
//       a2d assistant "switching to relative" [label] (LEAF)
function n(
  id: string,
  type: string,
  extra: object,
  children: SessionTreeNode[] = [],
): SessionTreeNode {
  return { entry: { id, type, ...extra } as never, children };
}
function m(
  id: string,
  message: object,
  children: SessionTreeNode[] = [],
  label?: string,
): SessionTreeNode {
  const node = n(id, "message", { message }, children);
  return label ? { ...node, label } : node;
}

function tree(): SessionTreeNode[] {
  return [
    n("m1", "model_change", { modelId: "anthropic/opus" }, [
      n("tl1", "thinking_level_change", { thinkingLevel: "medium" }, [
        n("si1", "session_info", { name: "Auth refactor" }, [
          m("u1", { role: "user", content: "fix the loader" }, [
            m(
              "a1",
              {
                role: "assistant",
                content: [
                  { type: "text", text: "looking now" },
                  { type: "toolCall", id: "tc1", name: "read", arguments: { path: "config.ts" } },
                ],
              },
              [
                m("tr1", { role: "toolResult", toolCallId: "tc1", content: "x" }, [
                  m("a1d", {
                    role: "assistant",
                    content: [{ type: "text", text: "fixed with absolute paths" }],
                  }),
                ]),
              ],
            ),
            m(
              "a2",
              { role: "assistant", content: [{ type: "text", text: "trying relative paths" }] },
              [
                m("tr2", { role: "toolResult", toolCallId: "tc2", content: "y" }, [
                  m(
                    "a2d",
                    {
                      role: "assistant",
                      content: [{ type: "text", text: "switching to relative" }],
                    },
                    [],
                    "alt-approach",
                  ),
                ]),
              ],
            ),
          ]),
        ]),
      ]),
    ]),
  ];
}

const opts = (over: Partial<FlattenOpts>): FlattenOpts => ({
  foldedIds: new Set(),
  filterMode: "default",
  search: "",
  leafId: "a2d",
  ...over,
});

const ids = (rows: { entry: { id: string } }[]) => rows.map((r) => r.entry.id);

describe("flattenVisible — default filter (regression: settings roots must not prune their subtree)", () => {
  it("hides settings entries but keeps every message beneath them", () => {
    const rows = flattenVisible(tree(), opts({}));
    const seen = ids(rows);
    // The three settings roots are hidden…
    expect(seen).not.toContain("m1");
    expect(seen).not.toContain("tl1");
    expect(seen).not.toContain("si1");
    // …but the conversation beneath them is fully present.
    expect(seen).toEqual(expect.arrayContaining(["u1", "a1", "tr1", "a1d", "a2", "tr2", "a2d"]));
  });

  it("orders the active-leaf branch before the sibling branch", () => {
    const rows = flattenVisible(tree(), opts({}));
    const seen = ids(rows);
    // a2 branch (contains the leaf a2d) comes before a1 branch.
    expect(seen.indexOf("a2")).toBeLessThan(seen.indexOf("a1"));
  });
});

describe("flattenVisible — branch-only indentation (regression: no per-line staircase)", () => {
  it("keeps a linear chain flat and only indents at the branch", () => {
    const rows = flattenVisible(tree(), opts({ filterMode: "all" }));
    const depth = Object.fromEntries(rows.map((r) => [r.entry.id, r.depth]));
    // Linear prefix (settings + u1) is all depth 0.
    expect(depth["m1"]).toBe(0);
    expect(depth["tl1"]).toBe(0);
    expect(depth["si1"]).toBe(0);
    expect(depth["u1"]).toBe(0);
    // Both branches start one level in. Their first-generation continuations
    // nest one deeper (pi's justBranched rule), then stay flat within the branch.
    expect(depth["a2"]).toBe(1);
    expect(depth["tr2"]).toBe(2);
    expect(depth["a2d"]).toBe(2);
    expect(depth["a1"]).toBe(1);
    expect(depth["tr1"]).toBe(2);
    expect(depth["a1d"]).toBe(2);
  });

  it("default mode also keeps u1 at depth 0 (its hidden settings parents don't add depth)", () => {
    const rows = flattenVisible(tree(), opts({}));
    const depth = Object.fromEntries(rows.map((r) => [r.entry.id, r.depth]));
    expect(depth["u1"]).toBe(0);
    expect(depth["a2"]).toBe(1);
  });
});

describe("flattenVisible — filter modes (pi parity)", () => {
  it("no-tools hides toolResult messages (there is no tool_call entry type)", () => {
    const seen = ids(flattenVisible(tree(), opts({ filterMode: "no-tools" })));
    expect(seen).not.toContain("tr1");
    expect(seen).not.toContain("tr2");
    expect(seen).toEqual(expect.arrayContaining(["u1", "a1", "a1d", "a2", "a2d"]));
  });

  it("user-only shows only user messages", () => {
    expect(ids(flattenVisible(tree(), opts({ filterMode: "user-only" })))).toEqual(["u1"]);
  });

  it("labeled-only shows only labeled entries", () => {
    expect(ids(flattenVisible(tree(), opts({ filterMode: "labeled-only" })))).toEqual(["a2d"]);
  });

  it("all shows settings entries too", () => {
    const seen = ids(flattenVisible(tree(), opts({ filterMode: "all" })));
    expect(seen).toEqual(expect.arrayContaining(["m1", "tl1", "si1"]));
  });
});

describe("flattenVisible — branch grouping (parity with pi's TUI justBranched rule)", () => {
  // Pi's TUI (modes/interactive/components/tree-selector.js flattenTree) gives the
  // FIRST generation after a branch point one extra indent level for visual grouping
  // (the `justBranched && indent > 0` rule). Without it, a branch point's children
  // AND their single-child continuations all collapse to the same depth, so the two
  // divergent branches no longer visibly descend from their common ancestor — the
  // tree looks like a flat list of siblings instead of two grouped branches.
  //
  //   u1 user "build feature"      ← branch point / common ancestor
  //     a2 assistant "approach B"   (active branch)
  //       u3 user "continue B"     ← must indent FURTHER than a2
  //     a1 assistant "approach A"
  //       u2 user "continue A"     ← must indent FURTHER than a1
  function forkedTree(): SessionTreeNode[] {
    return [
      n("m1", "model_change", { modelId: "anthropic/opus" }, [
        m("u1", { role: "user", content: "build feature" }, [
          m("a2", { role: "assistant", content: [{ type: "text", text: "approach B" }] }, [
            m("u3", { role: "user", content: "continue B" }),
          ]),
          m("a1", { role: "assistant", content: [{ type: "text", text: "approach A" }] }, [
            m("u2", { role: "user", content: "continue A" }),
          ]),
        ]),
      ]),
    ];
  }

  it("indents a branch's continuation deeper than the branch siblings (shows common ancestor)", () => {
    const rows = flattenVisible(forkedTree(), opts({ leafId: "u3" }));
    const depth = Object.fromEntries(rows.map((r) => [r.entry.id, r.depth]));
    // The two branches diverge from u1 (the common ancestor).
    expect(depth["u1"]).toBe(0);
    expect(depth["a2"]).toBe(1);
    expect(depth["a1"]).toBe(1);
    // CRITICAL: each branch's continuation must nest under its branch, not sit
    // alongside the branch siblings. This is what makes the two-branch structure
    // visible.
    expect(depth["u3"] ?? -1).toBeGreaterThan(depth["a2"] ?? -1);
    expect(depth["u2"] ?? -1).toBeGreaterThan(depth["a1"] ?? -1);
  });
});

describe("flattenVisible — active path + leaf", () => {
  it("marks the root→leaf chain as onActivePath", () => {
    const rows = flattenVisible(tree(), opts({}));
    const active = new Set(rows.filter((r) => r.onActivePath).map((r) => r.entry.id));
    expect(active).toEqual(new Set(["u1", "a2", "tr2", "a2d"]));
    expect(rows.find((r) => r.entry.id === "a2d")?.isLeaf).toBe(true);
  });
});

describe("flattenVisible — fold + search", () => {
  it("folding u1 hides its descendants", () => {
    const seen = ids(flattenVisible(tree(), opts({ foldedIds: new Set(["u1"]) })));
    expect(seen).toContain("u1");
    expect(seen).not.toContain("a1");
    expect(seen).not.toContain("a2");
  });

  it("search matches per node (AND-tokenized)", () => {
    const seen = ids(flattenVisible(tree(), opts({ search: "relative" })));
    // Only nodes whose own text matches — a2 ("trying relative paths") and
    // a2d ("switching to relative").
    expect(seen).toEqual(expect.arrayContaining(["a2", "a2d"]));
    expect(seen).not.toContain("a1d");
    expect(flattenVisible(tree(), opts({ search: "relative zzznope" }))).toHaveLength(0);
  });
});

describe("entryDisplayText", () => {
  it("prefixes user/assistant and brackets settings", () => {
    expect(
      entryDisplayText({
        id: "x",
        type: "message",
        message: { role: "user", content: "hi" },
      } as never),
    ).toBe("user: hi");
    expect(
      entryDisplayText({ id: "x", type: "model_change", modelId: "anthropic/opus" } as never),
    ).toBe("[model: anthropic/opus]");
    expect(
      entryDisplayText({ id: "x", type: "session_info", name: "Auth refactor" } as never),
    ).toBe("[title: Auth refactor]");
  });

  it("names a tool result from the harvested toolCall map", () => {
    const map = new Map([["tc1", { name: "read", args: { path: "config.ts" } }]]);
    expect(
      entryDisplayText(
        { id: "x", type: "message", message: { role: "toolResult", toolCallId: "tc1" } } as never,
        map,
      ),
    ).toBe("read config.ts");
  });
});

// Regression: contextBridge recursion-depth-exceeded on long sessions.
// The host sends a FLAT (parentId-keyed) node list because the nested tree's
// depth (= longest message chain) blows Electron's 1000-level contextBridge
// limit. buildNestedTree re-nests it in the renderer (no limit there); it must
// handle multi-thousand-deep linear chains without stack overflow and must
// faithfully reproduce the nested structure (so the flattener's output is
// identical to receiving the nested tree directly).
describe("buildNestedTree — flat→nested round-trip (contextBridge depth fix)", () => {
  it("reconstructs a branched tree from a flat parentId list, preserving sibling order", () => {
    const flat: FlatTreeNode[] = [
      { entry: { id: "r", type: "message", timestamp: "t0" }, parentId: undefined },
      { entry: { id: "a", type: "message", timestamp: "t1" }, parentId: "r" },
      { entry: { id: "b", type: "message", timestamp: "t2" }, parentId: "r" },
      { entry: { id: "a1", type: "message", timestamp: "t3" }, parentId: "a" },
    ];
    const nested = buildNestedTree(flat);
    expect(nested.map((n) => n.entry.id)).toEqual(["r"]);
    expect(nested[0]!.children.map((n) => n.entry.id)).toEqual(["a", "b"]);
    expect(nested[0]!.children[0]!.children.map((n) => n.entry.id)).toEqual(["a1"]);
  });

  it("survives a 20,000-deep linear chain without stack overflow (the reported bug)", () => {
    // A linear conversation of N messages is a flat list where each node's
    // parentId is the previous one. Nested, that's depth N — the shape that
    // exceeded both contextBridge's nesting limit and the renderer's call
    // stack. Reconstruction and every flattening traversal must be iterative.
    const N = 20_000;
    const flat: FlatTreeNode[] = [];
    for (let i = 0; i < N; i++) {
      flat.push({
        entry: { id: `n${i}`, type: "message", timestamp: `t${i}` },
        parentId: i === 0 ? undefined : `n${i - 1}`,
      });
    }
    const nested = buildNestedTree(flat);
    expect(nested).toHaveLength(1);
    // Walk down the single chain and confirm full depth + leaf identity.
    let node: SessionTreeNode | undefined = nested[0];
    let depth = 0;
    while (node) {
      depth++;
      node = node.children[0];
    }
    expect(depth).toBe(N);

    // And the flattener itself runs end-to-end on this deep chain, keeping it
    // at depth 0 (linear → flat, the no-staircase invariant).
    const rows = flattenVisible(nested, opts({ leafId: `n${N - 1}`, filterMode: "all" }));
    expect(rows).toHaveLength(N);
    expect(rows.every((r) => r.depth === 0)).toBe(true);
  });

  it("ignores a dangling parentId (corrupt entry must not crash rendering)", () => {
    const flat: FlatTreeNode[] = [
      { entry: { id: "r", type: "message", timestamp: "t0" }, parentId: undefined },
      { entry: { id: "orphan", type: "message", timestamp: "t1" }, parentId: "missing" },
    ];
    // An entry whose parent isn't in the list has no re-nesting home — it must
    // be dropped from the rendered tree rather than throw or loop.
    const nested = buildNestedTree(flat);
    expect(nested.map((n) => n.entry.id)).toEqual(["r"]);
    expect(nested[0]!.children).toEqual([]);
  });
});
