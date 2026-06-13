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

let current: AppSettings = defaultSettings;

export function loadSettings(): AppSettings {
  const filePath = getSettingsPath();
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = AppSettingsSchema.safeParse(JSON.parse(raw));
    if (parsed.success) {
      current = parsed.data;
    }
  } catch {
    current = defaultSettings;
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
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(current, null, 2), "utf8");
  fs.renameSync(tmpPath, filePath);

  return current;
}
