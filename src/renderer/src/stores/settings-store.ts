import type { AppSettings, ThemeAppearance } from "@shared/settings.js";
import { defaultSettings, resolveActiveColorScheme } from "@shared/settings.js";
import { create } from "zustand";
import { setShikiTheme } from "../lib/shiki.js";
import { getThemeForAppearance, setUserThemes } from "../theme/registry.js";

interface SettingsStore {
  settings: AppSettings;
  activeColorScheme: string;
  systemAppearance: ThemeAppearance;
  loaded: boolean;
  load: () => Promise<void>;
  update: (updates: Partial<AppSettings>) => Promise<void>;
  updateReadingFonts: (
    updates: Partial<Pick<AppSettings["fonts"], "title" | "transcriptHeader" | "transcriptBody">>,
  ) => Promise<void>;
}

export const useSettingsStore = create<SettingsStore>((set, get) => {
  let writeTail = Promise.resolve();
  let updateRevision = 0;
  let persistedSettings = defaultSettings;

  const publishSettings = (settings: AppSettings): void => {
    const systemAppearance = getSystemAppearance();
    set({
      settings,
      systemAppearance,
      activeColorScheme: resolveActiveThemeId(settings, systemAppearance),
    });
    applyFonts(settings);
    applyColorScheme(settings, systemAppearance);
  };

  const persistUpdate = (
    updates: Partial<AppSettings>,
    optimisticSettings: AppSettings,
  ): Promise<void> => {
    const revision = ++updateRevision;
    publishSettings(optimisticSettings);

    // Main persists each settings patch atomically. Serialize renderer writes so
    // a later patch cannot reach main first, and fence each response so an older
    // acknowledgement cannot repaint over a newer optimistic choice.
    const write = writeTail.then(() => window.pivis.invoke("settings.set", updates));
    writeTail = write.then(
      () => undefined,
      () => undefined,
    );
    return write.then(
      (settings) => {
        persistedSettings = settings;
        if (revision === updateRevision) publishSettings(settings);
      },
      (error: unknown) => {
        if (revision === updateRevision) publishSettings(persistedSettings);
        throw error;
      },
    );
  };

  return {
    settings: defaultSettings,
    activeColorScheme: resolveActiveThemeId(defaultSettings, getSystemAppearance()),
    systemAppearance: getSystemAppearance(),
    loaded: false,

    load: async () => {
      // Install user-droppable themes BEFORE the first paint so a saved
      // light/dark theme id pointing at a user theme resolves on load (not after a
      // flash of the default). Best-effort: a failed/empty fetch just leaves
      // the bundled themes in place.
      try {
        const userThemes = await window.pivis.invoke("themes.listUser", undefined);
        setUserThemes(userThemes);
      } catch {
        /* user themes unavailable — bundled themes still apply */
      }

      const settings = await window.pivis.invoke("settings.get", undefined);
      persistedSettings = settings;
      publishSettings(settings);
      set({ loaded: true });
      installSystemAppearanceListener(set);
    },

    update: (updates) => {
      const current = get().settings;
      return persistUpdate(updates, { ...current, ...updates });
    },

    updateReadingFonts: (updates) => {
      const current = get().settings;
      const fonts = { ...current.fonts, ...updates };
      return persistUpdate({ fonts }, { ...current, fonts });
    },
  };
});

let systemAppearanceListenerInstalled = false;

function getSystemAppearance(): ThemeAppearance {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return "dark";
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

function installSystemAppearanceListener(
  set: (
    partial: Partial<SettingsStore> | ((state: SettingsStore) => Partial<SettingsStore>),
  ) => void,
): void {
  if (systemAppearanceListenerInstalled) return;
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
  systemAppearanceListenerInstalled = true;
  const media = window.matchMedia("(prefers-color-scheme: light)");
  const onChange = (): void => {
    const systemAppearance = getSystemAppearance();
    set((state) => {
      const activeColorScheme = resolveActiveThemeId(state.settings, systemAppearance);
      applyColorScheme(state.settings, systemAppearance);
      return { systemAppearance, activeColorScheme };
    });
  };
  media.addEventListener("change", onChange);
}

function resolveActiveAppearance(
  settings: AppSettings,
  systemAppearance: ThemeAppearance,
): ThemeAppearance {
  if (settings.themeMode === "light" || settings.themeMode === "dark") return settings.themeMode;
  return systemAppearance;
}

function resolveActiveThemeId(settings: AppSettings, systemAppearance: ThemeAppearance): string {
  const appearance = resolveActiveAppearance(settings, systemAppearance);
  return getThemeForAppearance(resolveActiveColorScheme(settings, systemAppearance), appearance).id;
}

export function applyFonts(settings: AppSettings): void {
  const root = document.documentElement;
  // Keep the interface font family app-owned. UI alignment is tuned against
  // this stable metric set; exposing arbitrary system fonts makes controls
  // drift vertically even when their CSS box sizes remain correct.
  root.style.setProperty("--font-display", '"Inter", system-ui, -apple-system, sans-serif');
  // These user-selected families are quoted as one CSS family name before a
  // known app-owned fallback is appended. Quoting keeps punctuation in a
  // locally installed font name from turning into an invalid declaration and
  // guarantees every scope still has a usable face when that font disappears.
  root.style.setProperty(
    "--font-title",
    fontFamilyStack(settings.fonts.title.family, "var(--font-accent)"),
  );
  const transcriptHeaderStack = fontFamilyStack(
    settings.fonts.transcriptHeader.family,
    '"IBM Plex Serif", var(--font-display)',
  );
  root.style.setProperty("--font-transcript-heading", transcriptHeaderStack);
  root.style.setProperty("--font-thinking", transcriptHeaderStack);
  root.style.setProperty(
    "--font-transcript-body",
    fontFamilyStack(settings.fonts.transcriptBody.family, "var(--font-display)"),
  );
  // Append a generic fallback stack for code so that while the chosen font is
  // still loading — or if it isn't available at all (e.g. a custom family name
  // the user typed) — code degrades to the right *kind* of font. Without the
  // `monospace` tail, a bare unavailable code-font name falls through to the
  // browser's default *proportional* font.
  root.style.setProperty(
    "--font-code",
    `${settings.fonts.code.family}, "Menlo", "Monaco", "Courier New", monospace`,
  );
  // The user-controlled base size is applied to the root <html> element so
  // that `1rem` equals the user's chosen base. This is the *only* place we
  // touch a px value: it's the user-set anchor, not a hardcoded layout
  // measurement. All other typography/spacing in the app is rem/em.
  root.style.setProperty("--font-size-base", `${settings.fonts.display.sizePx}px`);
  // Code and small sizes are derived from the base, so they scale fluidly
  // with the user's base-size setting. Keep a root-derived code size for
  // code embedded inside larger serif text, where an em ratio would otherwise
  // compound with the parent font size.
  const codeRatio = settings.fonts.code.sizePx / settings.fonts.display.sizePx;
  root.style.setProperty("--font-size-code", `${codeRatio}em`);
  root.style.setProperty("--font-size-code-root", `calc(var(--font-size-base) * ${codeRatio})`);
  root.style.setProperty(
    "--font-size-small",
    `${(settings.fonts.display.sizePx - 2) / settings.fonts.display.sizePx}em`,
  );
}

function fontFamilyStack(family: string, fallback: string): string {
  const trimmed = family.trim();
  if (!trimmed) return fallback;
  const quoted = trimmed
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replace(/[\n\r\f]/g, " ");
  return `"${quoted}", ${fallback}`;
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
function applyColorScheme(settings: AppSettings, systemAppearance = getSystemAppearance()): void {
  const appearance = resolveActiveAppearance(settings, systemAppearance);
  const theme = getThemeForAppearance(
    resolveActiveColorScheme(settings, systemAppearance),
    appearance,
  );
  const root = document.documentElement;
  for (const [token, value] of Object.entries(theme.colors)) {
    // Optional roles type as `string | undefined`; skip absent ones (they get
    // an explicit fallback write below).
    if (value !== undefined) root.style.setProperty(`--${token}`, value);
  }
  // Optional roles need an explicit write-with-fallback: the loop above only
  // writes keys the theme HAS, so switching from a theme that sets one to a
  // theme that omits it would otherwise leave the previous theme's value
  // behind. Fallbacks mirror the tokens.ts contract (accent-fill → accent,
  // on-accent → bg).
  root.style.setProperty("--accent-fill", theme.colors["accent-fill"] ?? theme.colors.accent);
  root.style.setProperty("--on-accent", theme.colors["on-accent"] ?? theme.colors.bg);
  // Best-effort: a user theme's syntax may need an async Shiki load. CSS is
  // already applied above, so highlighting catches up on the next tokenize.
  void setShikiTheme(theme);
}
