import fs from "node:fs";
import { dialog } from "electron";
import { getSettings, saveSettings } from "./settings-store.js";

/** Cap on the number of tracked workspaces. */
const MAX_WORKSPACES = 20;

/**
 * Open the OS directory picker. On selection, the workspace is appended to the
 * END of `workspaceOrder` (never prepended) so it does not displace a
 * manually-positioned entry. A newly-picked workspace is also auto-expanded.
 */
export async function pickWorkspace(): Promise<string | null> {
  const result = await dialog.showOpenDialog({
    properties: ["openDirectory"],
    title: "Open Workspace",
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  const chosen = result.filePaths[0];
  if (!chosen) return null;

  const settings = getSettings();
  const order = settings.workspaceOrder.filter((w) => w !== chosen);
  order.push(chosen);
  const expanded = settings.expandedWorkspaces.includes(chosen)
    ? settings.expandedWorkspaces
    : [...settings.expandedWorkspaces, chosen];
  saveSettings({
    workspaceOrder: order.slice(-MAX_WORKSPACES),
    expandedWorkspaces: expanded,
    lastActiveWorkspace: chosen,
  });
  return chosen;
}

/**
 * Remove a workspace from `workspaceOrder` and `expandedWorkspaces`. Clears
 * `lastActiveWorkspace` if it pointed at the removed path. Returns the
 * remaining ordered list.
 */
export function removeWorkspace(path: string): string[] {
  const settings = getSettings();
  const order = settings.workspaceOrder.filter((w) => w !== path);
  const expanded = settings.expandedWorkspaces.filter((w) => w !== path);
  const updates: Partial<ReturnType<typeof getSettings>> = {
    workspaceOrder: order,
    expandedWorkspaces: expanded,
  };
  if (settings.lastActiveWorkspace === path) {
    updates.lastActiveWorkspace = null;
  }
  saveSettings(updates);
  return order;
}

/**
 * Return the manually-ordered workspace list, pruning any paths that no longer
 * exist on disk. Pruning does not reorder the survivors. Persists the pruned
 * list back if it changed. `expandedWorkspaces` is pruned to the survivors in
 * the same pass so stale expand entries can't accumulate for deleted paths.
 */
export function getOrderedWorkspaces(): string[] {
  const settings = getSettings();
  const order = settings.workspaceOrder;
  const existing = order.filter((p) => {
    try {
      return fs.statSync(p).isDirectory();
    } catch {
      return false;
    }
  });
  if (existing.length !== order.length) {
    const survivors = new Set(existing);
    const expanded = settings.expandedWorkspaces.filter((p) => survivors.has(p));
    const updates: Partial<ReturnType<typeof getSettings>> = { workspaceOrder: existing };
    if (expanded.length !== settings.expandedWorkspaces.length) {
      updates.expandedWorkspaces = expanded;
    }
    saveSettings(updates);
  }
  return existing;
}
