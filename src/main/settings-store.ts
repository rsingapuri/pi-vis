import fs from "node:fs";
import path from "node:path";
import { AppSettingsSchema } from "@shared/settings.js";
import type { AppSettings } from "@shared/settings.js";
import { buildThemeRegistry, resolveThemeForAppearance } from "@shared/theme/index.js";
import { app } from "electron";
import { getUserThemes } from "./theme-loader.js";

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
    json = migrateLegacyThemeSettings(json);
    const parsed = AppSettingsSchema.safeParse(json);
    if (parsed.success) {
      current = sanitizeThemeSettings(parsed.data);
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

function migrateLegacyThemeSettings(json: unknown): unknown {
  if (!json || typeof json !== "object") return json;
  const record = json as Record<string, unknown>;
  if (
    typeof record.colorScheme !== "string" ||
    "lightColorScheme" in record ||
    "darkColorScheme" in record ||
    "themeMode" in record
  ) {
    return json;
  }

  const legacyTheme = themeRegistry().get(record.colorScheme);
  const appearance = legacyTheme?.appearance ?? "dark";
  return {
    ...record,
    themeMode: appearance,
    ...(appearance === "light"
      ? { lightColorScheme: record.colorScheme }
      : { darkColorScheme: record.colorScheme }),
  };
}

function themeRegistry(): ReturnType<typeof buildThemeRegistry> {
  try {
    return buildThemeRegistry(getUserThemes());
  } catch {
    // Electron app path unavailable or user themes unreadable; bundled themes
    // are enough for defaults and tests.
    return buildThemeRegistry();
  }
}

function sanitizeThemeSettings(settings: AppSettings): AppSettings {
  const registry = themeRegistry();
  const lightColorScheme = resolveThemeForAppearance(
    settings.lightColorScheme,
    "light",
    registry,
  ).id;
  const darkColorScheme = resolveThemeForAppearance(settings.darkColorScheme, "dark", registry).id;
  if (
    lightColorScheme === settings.lightColorScheme &&
    darkColorScheme === settings.darkColorScheme
  ) {
    return settings;
  }
  return { ...settings, lightColorScheme, darkColorScheme };
}

export function getSettings(): AppSettings {
  return current;
}

export function saveSettings(updates: Partial<AppSettings>): AppSettings {
  const next = sanitizeThemeSettings(AppSettingsSchema.parse({ ...current, ...updates }));
  const filePath = getSettingsPath();
  const dir = path.dirname(filePath);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Commit to both disk and memory atomically from the caller's perspective:
  // a failed write must not leave an unpersisted candidate staged in `current`.
  const tmpPath = `${filePath}.tmp.${process.pid}`;
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(next, null, 2), "utf8");
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      /* ignore */
    }
    throw err;
  }

  current = next;
  return current;
}
