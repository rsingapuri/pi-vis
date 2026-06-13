import type { AppSettings } from "@shared/settings.js";
import { defaultSettings } from "@shared/settings.js";
import { create } from "zustand";

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
    const settings = await window.pivis.invoke("settings.get", undefined);
    set({ settings, loaded: true });

    // Apply font settings to CSS
    applyFonts(settings);
  },

  update: async (updates) => {
    const settings = await window.pivis.invoke("settings.set", updates);
    set({ settings });
    applyFonts(settings);
  },
}));

function applyFonts(settings: AppSettings): void {
  const root = document.documentElement;
  root.style.setProperty("--font-display", settings.fonts.display.family);
  root.style.setProperty("--font-code", settings.fonts.code.family);
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
