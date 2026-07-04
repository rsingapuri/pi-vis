import fs from "node:fs";
import path from "node:path";
import {
  type Theme,
  ThemeSchema,
  buildPiThemeColorIndices,
  buildThemeRegistry,
  piThemeForTheme,
  resolveTheme,
  resolveThemeForAppearance,
} from "@shared/theme/index.js";
import { app } from "electron";

// User-droppable themes live here. A JSON file conforming to ThemeSchema is
// loaded as an additional theme; the filename is advisory (the `id` field is
// authoritative). Invalid files are skipped with a warning, never fatal.
export function getUserThemesDir(): string {
  return path.join(app.getPath("userData"), "themes");
}

let cache: Theme[] | null = null;

/**
 * Load and validate every `<userData>/themes/*.json`. Cached after first read;
 * call `reloadUserThemes` to rescan (e.g. if we add a watcher later). Robust by
 * design: a missing dir, an unreadable file, or a schema violation each degrade
 * to "that theme just isn't there", never an exception out of this module.
 */
export function getUserThemes(): Theme[] {
  if (cache) return cache;
  cache = readUserThemes();
  return cache;
}

export function reloadUserThemes(): Theme[] {
  cache = readUserThemes();
  return cache;
}

function readUserThemes(): Theme[] {
  const dir = getUserThemesDir();
  let entries: string[];
  try {
    entries = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return []; // no themes dir yet — fine
  }

  const themes: Theme[] = [];
  const seen = new Set<string>();
  for (const file of entries) {
    const full = path.join(dir, file);
    try {
      const raw = JSON.parse(fs.readFileSync(full, "utf8"));
      const parsed = ThemeSchema.safeParse(raw);
      if (!parsed.success) {
        console.warn(`[theme-loader] skipping invalid theme ${file}: ${parsed.error.message}`);
        continue;
      }
      if (seen.has(parsed.data.id)) {
        console.warn(`[theme-loader] skipping duplicate theme id "${parsed.data.id}" (${file})`);
        continue;
      }
      seen.add(parsed.data.id);
      themes.push(parsed.data);
    } catch (err) {
      console.warn(`[theme-loader] failed to read theme ${file}:`, err);
    }
  }
  return themes;
}

/**
 * Resolve an active theme id to the pi built-in theme name ("dark" | "light")
 * the SDK host should load, considering both bundled and user themes. Used by
 * `getHostEnv` to set PIVIS_PI_THEME so extension/pi-tui surfaces track the
 * app theme's luminance.
 */
export function piThemeForSchemeId(
  id: string,
  expectedAppearance?: "dark" | "light",
): "dark" | "light" {
  const registry = buildThemeRegistry(getUserThemes());
  const theme = expectedAppearance
    ? resolveThemeForAppearance(id, expectedAppearance, registry)
    : resolveTheme(id, registry);
  return piThemeForTheme(theme);
}

/**
 * The stable pi-role → ANSI palette INDEX maps (`{fg, bg}`, each role → a fixed
 * index in 16–255) the SDK host should install so pi emits role-identity bytes
 * (`[38;5;N m`) rather than baked RGB. Scheme-INDEPENDENT and constant: the
 * host is color-agnostic, and the renderer resolves these indices against the
 * active palette at paint time (see `PI_ROLE_INDEX`). Serialized to the
 * `PIVIS_PI_THEME_COLORS` env var per host spawn.
 */
export function piThemeColorIndices(): {
  fg: Record<string, number>;
  bg: Record<string, number>;
} {
  return buildPiThemeColorIndices();
}
