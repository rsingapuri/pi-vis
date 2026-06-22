import fs from "node:fs";
import path from "node:path";
import { AppSettingsSchema, defaultSettings } from "@shared/settings.js";
import type { AppSettings } from "@shared/settings.js";
import { app } from "electron";

function getSettingsDir(): string {
  if (process.env["PIVIS_SETTINGS_DIR"]) {
    return process.env["PIVIS_SETTINGS_DIR"];
  }
  return app.getPath("userData");
}

function getSettingsPath(): string {
  return path.join(getSettingsDir(), "settings.json");
}

let current: AppSettings = AppSettingsSchema.parse({});

export function loadSettings(): AppSettings {
  const filePath = getSettingsPath();
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    let json: unknown = JSON.parse(raw);
    // Migration: `recentWorkspaces` (recency-sorted) was replaced by
    // `workspaceOrder` (manual order). Carry over any saved value on first
    // read so existing users don't lose their workspace list on upgrade.
    // Zod strips the now-unknown `recentWorkspaces` key during parse.
    if (
      json &&
      typeof json === "object" &&
      !("workspaceOrder" in (json as Record<string, unknown>)) &&
      Array.isArray((json as Record<string, unknown>).recentWorkspaces)
    ) {
      json = {
        ...json,
        workspaceOrder: (json as Record<string, unknown>).recentWorkspaces,
      };
    }
    const parsed = AppSettingsSchema.safeParse(json);
    if (parsed.success) {
      current = parsed.data;
      // Recovery: if the workspace list is empty but a last-active workspace
      // survived, seed the order from it. This rescues users whose legacy
      // `recentWorkspaces` was stripped by a build that shipped the
      // `workspaceOrder` schema field *before* the migration above existed
      // (the one-shot carry-over had nothing left to carry). Pruning on read
      // (`getOrderedWorkspaces`) drops it again if the path no longer exists.
      if (current.workspaceOrder.length === 0 && current.lastActiveWorkspace) {
        current = { ...current, workspaceOrder: [current.lastActiveWorkspace] };
      }
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn("[settings] failed to read settings.json:", err);
    }
    current = AppSettingsSchema.parse({});
  }
  return current;
}

export function getSettings(): AppSettings {
  return current;
}

export function saveSettings(updates: Partial<AppSettings>): AppSettings {
  current = AppSettingsSchema.parse({ ...current, ...updates });
  const filePath = getSettingsPath();
  const dir = path.dirname(filePath);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Atomic write: write to temp file, then rename
  const tmpPath = `${filePath}.tmp.${process.pid}`;
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(current, null, 2), "utf8");
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      /* ignore */
    }
    throw err;
  }

  return current;
}
