// Pure tree-flattening + display helpers for the conversation-tree viewer.
//
// Ported from pi's TUI tree-selector (modes/interactive/components/tree-selector.js)
// so the GUI overlay behaves identically: a FLAT ordered list whose rows are
// filtered/searched per-node, with indentation that only grows at genuine
// branch points (a linear conversation stays flat — no per-line staircase).
//
// Two load-bearing parity facts the original implementation got wrong:
//  1. Filtering is per-node on the flattened list — hiding a node does NOT
//     prune its subtree. Real sessions begin with settings entries
//     (model_change / thinking_level_change / session_info) at the ROOT, and
//     the default filter hides those; the old recursive "skip the subtree when
//     the node is filtered out" pruned every message beneath them, so default
//     showed nothing.
//  2. pi's session entries have NO `tool_call` type. Tool calls live inside
//     assistant-message content; tool *results* are `message` entries with
//     `role: "toolResult"`. The "no-tools" filter hides those toolResult
//     messages.

import type {
  FlatTreeNode,
  SessionTreeEntry,
  SessionTreeNode,
} from "@shared/pi-protocol/responses.js";
import type { TreeFilterMode } from "../../stores/tree-store.js";

/** Role/kind used for per-row coloring. */
export type RowKind = "user" | "assistant" | "tool" | "bash" | "summary" | "compaction" | "meta";

/**
 * Re-nest a flat (parentId-keyed) node list back into the recursive
 * SessionTreeNode[] the flattener consumes. The wire format is flat (see
 * FlatTreeNode) to dodge the contextBridge's 1000-level nesting limit; the
 * renderer can safely rebuild the presentation. Iterative (no recursion) so a
 * multi-thousand-message linear session can't stack-overflow here either.
 * Preserves the flat array's
 * sibling order within each parent group.
 */
export function buildNestedTree(flat: FlatTreeNode[]): SessionTreeNode[] {
  const nodesById = new Map<string, SessionTreeNode>();
  // parentId (undefined for roots) → ordered child ids, in flat-array order.
  const childIdsByParent = new Map<string | undefined, string[]>();
  for (const f of flat) {
    // Skip a node whose own id recurses defensively (shouldn't happen, but a
    // malformed entry must never create a self-referential tree).
    if (nodesById.has(f.entry.id)) continue;
    nodesById.set(f.entry.id, {
      entry: f.entry,
      children: [],
      label: f.label,
      labelTimestamp: f.labelTimestamp,
    });
    const list = childIdsByParent.get(f.parentId);
    if (list) list.push(f.entry.id);
    else childIdsByParent.set(f.parentId, [f.entry.id]);
  }
  // Wire children. Guard against a child id that isn't in the flat list (a
  // stale/dangling parentId) so a corrupt entry can't crash rendering.
  for (const f of flat) {
    const node = nodesById.get(f.entry.id);
    if (!node) continue;
    const childIds = childIdsByParent.get(f.entry.id);
    if (!childIds) continue;
    for (const cid of childIds) {
      const child = nodesById.get(cid);
      if (child) node.children.push(child);
    }
  }
  const rootIds = childIdsByParent.get(undefined) ?? [];
  const roots: SessionTreeNode[] = [];
  for (const id of rootIds) {
    const n = nodesById.get(id);
    if (n) roots.push(n);
  }
  return roots;
}

export interface VisibleRow {
  entry: SessionTreeEntry;
  /** Branch-only depth: 0 for a linear chain, +1 under each branch point. */
  depth: number;
  label: string | undefined;
  /** On the root→current-leaf path (rendered with the `•` active marker). */
  onActivePath: boolean;
  /** This is the current active leaf. */
  isLeaf: boolean;
  /** Has children in the full tree (so the fold chevron is meaningful). */
  foldable: boolean;
  folded: boolean;
  /** Pre-formatted, single-line display text (mirrors pi's getEntryDisplayText). */
  text: string;
  kind: RowKind;
}

export interface FlattenOpts {
  foldedIds: Set<string>;
  filterMode: TreeFilterMode;
  search: string;
  leafId: string | null;
}

interface InternalNode {
  node: SessionTreeNode;
  parentId: string | undefined;
}

/**
 * Flatten a SessionTreeNode[] into the visible-row list. Mirrors pi's
 * TreeList: flatten once (active branch ordered first), filter each node
 * independently, drop descendants of folded nodes, then recompute the
 * branch-only depth on the surviving (visible) nodes.
 */
export function flattenVisible(roots: SessionTreeNode[], opts: FlattenOpts): VisibleRow[] {
  // ── Index the full tree ───────────────────────────────────────────────
  const byId = new Map<string, InternalNode>();
  const toolCallMap = new Map<string, { name: string; args: unknown }>();
  for (const root of roots) indexNode(root, undefined, byId, toolCallMap);

  // ── Active path and the subtrees containing it. Walking parent links is
  //    iterative: conversation depth is controlled by session data and must
  //    never become JavaScript call-stack depth. ──────────────────────────
  const activePath = new Set<string>();
  const containsActive = new Map<string, boolean>();
  if (opts.leafId) {
    let cur: string | undefined = opts.leafId;
    while (cur && !activePath.has(cur)) {
      activePath.add(cur);
      if (byId.has(cur)) containsActive.set(cur, true);
      cur = byId.get(cur)?.parentId;
    }
  }

  const tokens = opts.search.toLowerCase().split(/\s+/).filter(Boolean);

  // ── Per-node visibility (filter + search), no subtree pruning ──────────
  const isVisible = (n: SessionTreeNode, hiddenByFold: boolean): boolean => {
    if (!passesFilter(n, opts.filterMode, opts.leafId)) return false;
    if (hiddenByFold) return false;
    if (tokens.length > 0) {
      const hay = searchableText(n, toolCallMap).toLowerCase();
      if (!tokens.every((t) => hay.includes(t))) return false;
    }
    return true;
  };

  // ── Iterative pre-order DFS in active-first order. The frame carries fold
  //    state and the nearest visible ancestor, avoiding both recursion and
  //    repeated rootward scans on very deep sessions. ─────────────────────
  const visibleOrder: SessionTreeNode[] = [];
  // parentId (undefined = visible root) → visible children, in flattened order.
  const visibleChildren = new Map<string | undefined, string[]>();
  interface VisitFrame {
    node: SessionTreeNode;
    hiddenByFold: boolean;
    visibleAncestor: string | undefined;
  }
  const visitStack: VisitFrame[] = [];
  const orderedRoots = orderChildren(roots, containsActive);
  for (let i = orderedRoots.length - 1; i >= 0; i--) {
    visitStack.push({ node: orderedRoots[i]!, hiddenByFold: false, visibleAncestor: undefined });
  }
  while (visitStack.length > 0) {
    const { node, hiddenByFold, visibleAncestor } = visitStack.pop()!;
    const visible = isVisible(node, hiddenByFold);
    if (visible) {
      visibleOrder.push(node);
      const siblings = visibleChildren.get(visibleAncestor);
      if (siblings) siblings.push(node.entry.id);
      else visibleChildren.set(visibleAncestor, [node.entry.id]);
    }

    const childHiddenByFold = hiddenByFold || opts.foldedIds.has(node.entry.id);
    const childVisibleAncestor = visible ? node.entry.id : visibleAncestor;
    const children = orderChildren(node.children ?? [], containsActive);
    for (let i = children.length - 1; i >= 0; i--) {
      visitStack.push({
        node: children[i]!,
        hiddenByFold: childHiddenByFold,
        visibleAncestor: childVisibleAncestor,
      });
    }
  }

  // ── Branch-only depth, ported from pi's TUI ───────────────────────────
  // Faithful port of tree-selector.js recalculateVisualStructure: a top-down
  // traversal that propagates a `justBranched` flag (= "this node's visible
  // parent was a branch point"). The indent rules are:
  //   branch point (>1 visible child)         → child +1
  //   first generation after a branch         → child +1   (justBranched && indent>0)
  //   single-child chain                      → flat
  // The middle rule is load-bearing: without it a fork's continuation collapses
  // to the same depth as the branch siblings, so two divergent branches no
  // longer visibly descend from their common ancestor (they read as a flat
  // sibling list). multipleRoots mirrors pi's virtual-root shift (roots render
  // at depth 0 even though their internal indent is 1).
  const visibleRoots = visibleChildren.get(undefined) ?? [];
  const multipleRoots = visibleRoots.length > 1;
  const rootIndent = multipleRoots ? 1 : 0;
  const depthMap = new Map<string, number>();
  interface Frame {
    id: string;
    indent: number;
    justBranched: boolean;
  }
  const stack: Frame[] = [];
  for (let i = visibleRoots.length - 1; i >= 0; i--) {
    stack.push({ id: visibleRoots[i]!, indent: rootIndent, justBranched: multipleRoots });
  }
  while (stack.length > 0) {
    const { id, indent, justBranched } = stack.pop()!;
    depthMap.set(id, indent);
    const kids = visibleChildren.get(id) ?? [];
    const multipleChildren = kids.length > 1;
    let childIndent: number;
    if (multipleChildren) childIndent = indent + 1;
    else if (justBranched && indent > 0) childIndent = indent + 1;
    else childIndent = indent;
    for (let i = kids.length - 1; i >= 0; i--) {
      stack.push({ id: kids[i]!, indent: childIndent, justBranched: multipleChildren });
    }
  }
  const depthFor = (id: string): number => {
    const indent = depthMap.get(id) ?? 0;
    return multipleRoots ? Math.max(0, indent - 1) : indent;
  };

  // ── Build rows ─────────────────────────────────────────────────────────
  return visibleOrder.map((n) => ({
    entry: n.entry,
    depth: depthFor(n.entry.id),
    label: n.label,
    onActivePath: activePath.has(n.entry.id),
    isLeaf: n.entry.id === opts.leafId,
    foldable: (n.children?.length ?? 0) > 0,
    folded: opts.foldedIds.has(n.entry.id),
    text: entryDisplayText(n.entry, toolCallMap),
    kind: rowKind(n.entry),
  }));
}

function indexNode(
  node: SessionTreeNode,
  parentId: string | undefined,
  byId: Map<string, InternalNode>,
  toolCallMap: Map<string, { name: string; args: unknown }>,
): void {
  const stack: InternalNode[] = [{ node, parentId }];
  while (stack.length > 0) {
    const current = stack.pop()!;
    byId.set(current.node.entry.id, current);
    // Harvest tool calls from assistant content so toolResult rows can name them.
    const entry = current.node.entry;
    if (entry.type === "message") {
      const content = (entry.message as { content?: unknown } | undefined)?.content;
      if (Array.isArray(content)) {
        for (const part of content) {
          if (typeof part === "object" && part !== null) {
            const p = part as Record<string, unknown>;
            if (p["type"] === "toolCall" && typeof p["id"] === "string") {
              toolCallMap.set(p["id"], {
                name: typeof p["name"] === "string" ? p["name"] : "tool",
                args: p["arguments"],
              });
            }
          }
        }
      }
    }
    const children = current.node.children ?? [];
    for (let i = children.length - 1; i >= 0; i--) {
      stack.push({ node: children[i]!, parentId: entry.id });
    }
  }
}

/** Order children so the branch containing the active leaf comes first. */
function orderChildren(
  children: SessionTreeNode[],
  containsActive: Map<string, boolean>,
): SessionTreeNode[] {
  const prioritized: SessionTreeNode[] = [];
  const rest: SessionTreeNode[] = [];
  for (const c of children) {
    if (containsActive.get(c.entry.id)) prioritized.push(c);
    else rest.push(c);
  }
  return [...prioritized, ...rest];
}

/**
 * Per-node filter predicate — mirrors pi's TreeList.applyFilter switch plus the
 * "hide assistant messages with only tool calls (no text), unless current leaf
 * or error/aborted" pre-rule.
 */
export function passesFilter(
  node: SessionTreeNode,
  mode: TreeFilterMode,
  leafId: string | null,
): boolean {
  const entry = node.entry;
  const isCurrentLeaf = entry.id === leafId;

  // Hide content-less assistant turns (tool-call-only) unless they're the
  // current leaf or carry an error/abort — same as pi.
  if (entry.type === "message") {
    const msg = entry.message as
      | { role?: string; content?: unknown; stopReason?: string }
      | undefined;
    if (msg?.role === "assistant" && !isCurrentLeaf) {
      const hasText = hasTextContent(msg.content);
      const isErrorOrAborted =
        !!msg.stopReason && msg.stopReason !== "stop" && msg.stopReason !== "toolUse";
      if (!hasText && !isErrorOrAborted) return false;
    }
  }

  const isSettingsEntry =
    entry.type === "label" ||
    entry.type === "custom" ||
    entry.type === "model_change" ||
    entry.type === "thinking_level_change" ||
    entry.type === "session_info";

  switch (mode) {
    case "user-only":
      return entry.type === "message" && roleOf(entry) === "user";
    case "no-tools":
      return !isSettingsEntry && !(entry.type === "message" && roleOf(entry) === "toolResult");
    case "labeled-only":
      return node.label !== undefined;
    case "all":
      return true;
    default:
      return !isSettingsEntry;
  }
}

function roleOf(entry: SessionTreeEntry): string | undefined {
  return (entry.message as { role?: string } | undefined)?.role;
}

function hasTextContent(content: unknown): boolean {
  if (typeof content === "string") return content.trim().length > 0;
  if (Array.isArray(content)) {
    for (const c of content) {
      if (
        typeof c === "object" &&
        c !== null &&
        (c as Record<string, unknown>)["type"] === "text"
      ) {
        const t = (c as Record<string, unknown>)["text"];
        if (typeof t === "string" && t.trim().length > 0) return true;
      }
    }
  }
  return false;
}

function searchableText(
  node: SessionTreeNode,
  toolCallMap: Map<string, { name: string; args: unknown }>,
): string {
  const parts: string[] = [];
  if (node.label) parts.push(node.label);
  parts.push(node.entry.type);
  parts.push(entryDisplayText(node.entry, toolCallMap));
  return parts.join(" ");
}

export function rowKind(entry: SessionTreeEntry): RowKind {
  switch (entry.type) {
    case "message": {
      const role = roleOf(entry);
      if (role === "user") return "user";
      if (role === "assistant") return "assistant";
      if (role === "toolResult") return "tool";
      if (role === "bashExecution") return "bash";
      return "meta";
    }
    case "branch_summary":
      return "summary";
    case "compaction":
      return "compaction";
    default:
      return "meta";
  }
}

function extractContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    let out = "";
    for (const c of content) {
      if (
        typeof c === "object" &&
        c !== null &&
        (c as Record<string, unknown>)["type"] === "text"
      ) {
        out += String((c as Record<string, unknown>)["text"] ?? "");
      }
    }
    return out;
  }
  return "";
}

/**
 * Single-line display text for an entry — mirrors pi's getEntryDisplayText
 * (role-prefixed message text, tool-result names, bracketed bookkeeping).
 */
export function entryDisplayText(
  entry: SessionTreeEntry,
  toolCallMap?: Map<string, { name: string; args: unknown }>,
): string {
  switch (entry.type) {
    case "message": {
      const msg = entry.message as
        | {
            role?: string;
            content?: unknown;
            stopReason?: string;
            errorMessage?: string;
            toolCallId?: string;
            toolName?: string;
            command?: string;
          }
        | undefined;
      const role = msg?.role;
      if (role === "user") return `user: ${oneLine(extractContent(msg?.content))}`;
      if (role === "assistant") {
        const text = oneLine(extractContent(msg?.content));
        if (text) return `assistant: ${text}`;
        if (msg?.stopReason === "aborted") return "assistant: (aborted)";
        if (msg?.errorMessage) return `assistant: ${oneLine(msg.errorMessage)}`;
        return "assistant: (no content)";
      }
      if (role === "toolResult") {
        const tc = msg?.toolCallId ? toolCallMap?.get(msg.toolCallId) : undefined;
        if (tc) return formatToolCall(tc.name, tc.args);
        return `[${msg?.toolName ?? "tool"}]`;
      }
      if (role === "bashExecution") return `[bash]: ${oneLine(msg?.command ?? "")}`;
      return `[${role ?? "message"}]`;
    }
    case "branch_summary": {
      const s = (entry as { summary?: string }).summary;
      return `[branch summary]: ${oneLine(s ?? "")}`;
    }
    case "compaction": {
      const tokensBefore = (entry as { tokensBefore?: number }).tokensBefore ?? 0;
      return `[compaction: ${Math.round(tokensBefore / 1000)}k tokens]`;
    }
    case "model_change":
      return `[model: ${(entry as { modelId?: string }).modelId ?? "?"}]`;
    case "thinking_level_change":
      return `[thinking: ${(entry as { thinkingLevel?: string }).thinkingLevel ?? "?"}]`;
    case "custom":
      return `[custom: ${(entry as { customType?: string }).customType ?? "?"}]`;
    case "custom_message": {
      const c = (entry as { content?: unknown; customType?: string }).content;
      return `[${(entry as { customType?: string }).customType ?? "custom"}]: ${oneLine(extractContent(c))}`;
    }
    case "label":
      return `[label: ${(entry as { label?: string }).label ?? "(cleared)"}]`;
    case "session_info": {
      const n = (entry as { name?: string }).name;
      return n ? `[title: ${n}]` : "[title: empty]";
    }
    default:
      return entry.type;
  }
}

/** Compact tool-call summary (pi's formatToolCall, abbreviated to name + path/cmd). */
function formatToolCall(name: string, args: unknown): string {
  if (args && typeof args === "object") {
    const a = args as Record<string, unknown>;
    const path = a["path"] ?? a["file_path"] ?? a["filePath"];
    if (typeof path === "string" && path) return `${name} ${oneLine(path)}`;
    if (typeof a["command"] === "string" && a["command"])
      return `${name}: ${oneLine(a["command"] as string)}`;
    if (typeof a["pattern"] === "string" && a["pattern"])
      return `${name} ${oneLine(a["pattern"] as string)}`;
  }
  return name;
}

function oneLine(s: string): string {
  const collapsed = s.replace(/\s+/g, " ").trim();
  return collapsed.length > 120 ? `${collapsed.slice(0, 117)}…` : collapsed;
}
