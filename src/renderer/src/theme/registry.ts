import {
  type Theme,
  buildThemeRegistry,
  resolveTheme,
  resolveThemeForAppearance,
} from "@shared/theme";

/**
 * Renderer-side theme registry. Holds the bundled themes plus any
 * user-droppable themes loaded from disk (fetched once at settings load via
 * the `themes.listUser` IPC and installed with `setUserThemes`). The xterm
 * panels and the settings picker read from here so they see the same set the
 * CSS applier does.
 */
let registry = buildThemeRegistry();

/** Replace the user-theme layer; bundled themes are always kept. */
export function setUserThemes(userThemes: readonly Theme[]): void {
  registry = buildThemeRegistry(userThemes);
}

/** Resolve a theme id to a Theme, falling back to the default. */
export function getTheme(id: string): Theme {
  return resolveTheme(id, registry);
}

/** Resolve a split light/dark theme id, falling back within that appearance. */
export function getThemeForAppearance(id: string, appearance: Theme["appearance"]): Theme {
  return resolveThemeForAppearance(id, appearance, registry);
}

/** All themes (bundled + user), for the settings picker. */
export function listThemes(): Theme[] {
  return [...registry.values()];
}
