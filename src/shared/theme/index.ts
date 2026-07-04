import {
  BUNDLED_THEMES,
  DEFAULT_DARK_THEME_ID,
  DEFAULT_LIGHT_THEME_ID,
  DEFAULT_THEME_ID,
} from "./bundled.js";
import type { Theme } from "./tokens.js";

export {
  BUNDLED_THEMES,
  DEFAULT_DARK_THEME_ID,
  DEFAULT_LIGHT_THEME_ID,
  DEFAULT_THEME_ID,
} from "./bundled.js";
export {
  COLOR_TOKENS,
  type ColorToken,
  OPTIONAL_COLOR_TOKENS,
  type OptionalColorToken,
  type SyntaxSpec,
  type Theme,
  type ThemeColors,
  ThemeColorsSchema,
  ThemeSchema,
  SyntaxSpecSchema,
} from "./tokens.js";
export {
  buildPiThemeColorIndices,
  buildPiThemeColors,
  PI_BG_ROLES,
  PI_INDEX_ROLE,
  PI_INDEX_TOKEN,
  PI_ROLE_INDEX,
  PI_ROLES,
  PI_THEME_DEFAULTS,
} from "./pi-theme.js";

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
 * Resolve a saved theme id against a registry, falling back to the
 * default theme (then to the first bundled theme) so the app always paints
 * with a real theme even if a persisted id was removed.
 */
export function resolveTheme(id: string, registry: Map<string, Theme>): Theme {
  // BUNDLED_THEMES is non-empty, so the final fallback always yields a real
  // Theme even if the registry was somehow empty.
  const found = registry.get(id) ?? registry.get(DEFAULT_THEME_ID) ?? BUNDLED_THEMES[0];
  return found as Theme;
}

/**
 * Resolve a saved theme id for a specific light/dark slot. If the saved id is
 * stale — or resolves to the wrong appearance because a settings file was hand
 * edited or a user theme overrode a bundled id — fallback within the expected
 * appearance. This prevents the light slot from ever falling through to the
 * global dark default (Mocha), and vice versa.
 */
export function resolveThemeForAppearance(
  id: string,
  appearance: Theme["appearance"],
  registry: Map<string, Theme>,
): Theme {
  const saved = registry.get(id);
  if (saved?.appearance === appearance) return saved;

  const defaultId = appearance === "light" ? DEFAULT_LIGHT_THEME_ID : DEFAULT_DARK_THEME_ID;
  const registryDefault = registry.get(defaultId);
  if (registryDefault?.appearance === appearance) return registryDefault;

  const bundledDefault = BUNDLED_THEMES.find(
    (theme) => theme.id === defaultId && theme.appearance === appearance,
  );
  if (bundledDefault) return bundledDefault;

  return (
    [...registry.values()].find((theme) => theme.appearance === appearance) ??
    BUNDLED_THEMES.find((theme) => theme.appearance === appearance) ??
    resolveTheme(id, registry)
  );
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
