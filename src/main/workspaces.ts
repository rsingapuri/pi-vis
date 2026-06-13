import { dialog } from "electron";
import { getSettings, saveSettings } from "./settings-store.js";

export async function pickWorkspace(): Promise<string | null> {
  const result = await dialog.showOpenDialog({
    properties: ["openDirectory"],
    title: "Open Workspace",
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  const chosen = result.filePaths[0];
  if (!chosen) return null;

  // Add to recents
  const settings = getSettings();
  const recents = [chosen, ...settings.recentWorkspaces.filter((w) => w !== chosen)].slice(0, 20);
  saveSettings({ recentWorkspaces: recents });

  return chosen;
}

export function removeRecentWorkspace(path: string): string[] {
  const settings = getSettings();
  const recents = settings.recentWorkspaces.filter((w) => w !== path);
  const updates: Partial<ReturnType<typeof getSettings>> = { recentWorkspaces: recents };
  if (settings.lastActiveWorkspace === path) {
    updates.lastActiveWorkspace = null;
  }
  saveSettings(updates);
  return recents;
}

export function getRecentWorkspaces(): string[] {
  return getSettings().recentWorkspaces;
}
