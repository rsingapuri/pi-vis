import catppuccinFrappe from "./themes/catppuccin-frappe.json";
import catppuccinLatte from "./themes/catppuccin-latte.json";
import catppuccinMacchiato from "./themes/catppuccin-macchiato.json";
import catppuccinMocha from "./themes/catppuccin-mocha.json";
import gruvboxMaterialDark from "./themes/gruvbox-material-dark.json";
import { type Theme, ThemeSchema } from "./tokens.js";

/**
 * In-repo themes, one JSON file per colorscheme under `themes/`. Each file is
 * pure data conforming to {@link ThemeSchema}; we parse it here so a malformed
 * bundled theme fails loudly at startup rather than rendering a half-painted
 * app. User-droppable themes (`<userData>/themes/*.json`) are merged on top of
 * these at runtime; a user theme whose `id` collides with a bundled one
 * overrides it.
 *
 * Order matters only for the last-resort fallback in `resolveTheme`
 * (`BUNDLED_THEMES[0]`), so keep the canonical default (mocha) first.
 */
export const BUNDLED_THEMES: readonly Theme[] = [
  ThemeSchema.parse(catppuccinMocha),
  ThemeSchema.parse(catppuccinMacchiato),
  ThemeSchema.parse(catppuccinFrappe),
  ThemeSchema.parse(catppuccinLatte),
  ThemeSchema.parse(gruvboxMaterialDark),
];

/** The id rendered before settings load / when a saved id no longer resolves. */
export const DEFAULT_THEME_ID = "mocha";
