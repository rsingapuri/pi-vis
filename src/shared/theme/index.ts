import { BUNDLED_THEMES, DEFAULT_THEME_ID } from "./bundled.js";
import type { Theme } from "./tokens.js";

export { BUNDLED_THEMES, DEFAULT_THEME_ID } from "./bundled.js";
export {
  COLOR_TOKENS,
  type ColorToken,
  type SyntaxSpec,
  type Theme,
  type ThemeColors,
  ThemeColorsSchema,
  ThemeSchema,
  SyntaxSpecSchema,
} from "./tokens.js";

/**
 * Build an id → Theme registry from the bundled themes plus any extra
 * (user-droppable) themes. Later entries win on id collision, so a user theme
 * may override a bundled one of the same id.
 */
export function buildThemeRegistry(extra: readonly Theme[] = []): Map<string, Theme> {
  const registry = new Map<string, Theme>();
  for (const theme of [...BUNDLED_THEMES, ...extra]) {
    registry.set(theme.id, theme);
  }
  return registry;
}

/**
 * Resolve a saved colorScheme id against a registry, falling back to the
 * default theme (then to the first bundled theme) so the app always paints
 * with a real theme even if a persisted id was removed.
 */
export function resolveTheme(id: string, registry: Map<string, Theme>): Theme {
  // BUNDLED_THEMES is non-empty (five themes compiled in), so the final
  // fallback always yields a real Theme even if the registry was somehow empty.
  const found = registry.get(id) ?? registry.get(DEFAULT_THEME_ID) ?? BUNDLED_THEMES[0];
  return found as Theme;
}

/**
 * Map a theme to the pi theme name the SDK host should load. pi ships exactly
 * two built-in themes — "dark" and "light" — and resolves every extension /
 * pi-tui color against the active one, so the host theme must track the
 * pi-vis theme's luminance. This replaces the old per-flavor
 * `piThemeForColorScheme`, generalized to any theme via its declared
 * `appearance`.
 */
export function piThemeForTheme(theme: Theme): "dark" | "light" {
  return theme.appearance;
}
