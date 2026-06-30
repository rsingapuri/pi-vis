import type { AppSettings } from "@shared/settings.js";
import { defaultSettings } from "@shared/settings.js";
import { create } from "zustand";
import { setShikiTheme } from "../lib/shiki.js";
import { getTheme, setUserThemes } from "../theme/registry.js";

interface SettingsStore {
  settings: AppSettings;
  loaded: boolean;
  load: () => Promise<void>;
  update: (updates: Partial<AppSettings>) => Promise<void>;
}

export const useSettingsStore = create<SettingsStore>((set) => ({
  settings: defaultSettings,
  loaded: false,

  load: async () => {
    // Install user-droppable themes BEFORE the first paint so a saved
    // colorScheme pointing at a user theme resolves on load (not after a
    // flash of the default). Best-effort: a failed/empty fetch just leaves
    // the bundled themes in place.
    try {
      const userThemes = await window.pivis.invoke("themes.listUser", undefined);
      setUserThemes(userThemes);
    } catch {
      /* user themes unavailable — bundled themes still apply */
    }

    const settings = await window.pivis.invoke("settings.get", undefined);
    set({ settings, loaded: true });

    // Apply visual settings to the DOM. We do fonts and color scheme
    // together so a single settings load fully paints the UI.
    applyFonts(settings);
    applyColorScheme(settings);
  },

  update: async (updates) => {
    const settings = await window.pivis.invoke("settings.set", updates);
    set({ settings });
    applyFonts(settings);
    applyColorScheme(settings);
  },
}));

function applyFonts(settings: AppSettings): void {
  const root = document.documentElement;
  // Append generic fallback stacks (matching theme.css defaults) so that
  // while the chosen webfont is still loading — or if it isn't available at
  // all (e.g. a custom family name the user typed) — text degrades to the
  // right *kind* of font. Without the `monospace` tail, a bare unavailable
  // code-font name falls through to the browser's default *proportional*
  // font, making code blocks render in a display-like font.
  root.style.setProperty(
    "--font-display",
    `${settings.fonts.display.family}, system-ui, -apple-system, sans-serif`,
  );
  root.style.setProperty(
    "--font-code",
    `${settings.fonts.code.family}, "Menlo", "Monaco", "Courier New", monospace`,
  );
  // The user-controlled base size is applied to the root <html> element so
  // that `1rem` equals the user's chosen base. This is the *only* place we
  // touch a px value: it's the user-set anchor, not a hardcoded layout
  // measurement. All other typography/spacing in the app is rem/em.
  root.style.setProperty("--font-size-base", `${settings.fonts.display.sizePx}px`);
  // Code and small sizes are derived as em ratios of the base, so they
  // scale fluidly with the user's base-size setting.
  const codeRatio = settings.fonts.code.sizePx / settings.fonts.display.sizePx;
  root.style.setProperty("--font-size-code", `${codeRatio}em`);
  root.style.setProperty(
    "--font-size-small",
    `${(settings.fonts.display.sizePx - 2) / settings.fonts.display.sizePx}em`,
  );
}

/**
 * Apply the active theme to the document root. Each semantic role in the
 * resolved Theme's `colors` map is written as a `--<token>` CSS variable
 * (e.g. `accent` → `--accent`); the composite `--color-*` tokens in theme.css
 * reference those, so a single pass recolors every component.
 *
 * Shiki is updated in the same call so its tokenized HTML uses the theme's
 * syntax theme (CSS variables don't touch Shiki's baked-in hex tokens).
 */
function applyColorScheme(settings: AppSettings): void {
  const theme = getTheme(settings.colorScheme);
  const root = document.documentElement;
  for (const [token, value] of Object.entries(theme.colors)) {
    root.style.setProperty(`--${token}`, value);
  }
  // Best-effort: a user theme's syntax may need an async Shiki load. CSS is
  // already applied above, so highlighting catches up on the next tokenize.
  void setShikiTheme(theme);
}
