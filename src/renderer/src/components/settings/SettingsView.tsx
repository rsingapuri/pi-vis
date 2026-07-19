import type { AppUpdateStatus } from "@shared/app-updates.js";
import type { ProviderAuthStatus } from "@shared/auth.js";
import { PROVIDERS } from "@shared/auth.js";
import type { ExtensionUpdateStatus, ExtensionUpdateTarget } from "@shared/extension-updates.js";
import type { ThemeMode, TranscriptStyle } from "@shared/settings.js";
import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { formatMiB, parseSizeToMiB } from "../../lib/file-size.js";
import { useAppUpdatesStore } from "../../stores/app-updates-store.js";
import {
  checkExtensionUpdates,
  useExtensionUpdatesStore,
} from "../../stores/extension-updates-store.js";
import { useSettingsStore } from "../../stores/settings-store.js";
import { listThemes } from "../../theme/registry.js";
import { LoginTerminal } from "../auth/LoginTerminal.js";
import { FadeText } from "../common/FadeText.js";
import { ScrollFadeFrame } from "../common/ScrollFadeFrame.js";
import { IconCheck, IconChevronDown, IconClose } from "../common/icons.js";
import "./SettingsView.css";

interface FontFamily {
  family: string;
  fullName?: string;
}

/**
 * Fonts shipped with the app (bundled via @fontsource in main.tsx). These are
 * NOT installed system fonts, so `queryLocalFonts()` never lists them. The code
 * font picker still needs bundled monospace options to appear even when they
 * are not system-installed.
 */
const BUNDLED_FONTS = ["IBM Plex Mono"];

/**
 * Build the family-dropdown options: bundled fonts first, then the currently
 * selected family (so a custom value the user typed always has a matching
 * option), then the system fonts — all de-duplicated.
 */
function buildFontOptions(localFonts: FontFamily[], current: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const family of [...BUNDLED_FONTS, current, ...localFonts.map((f) => f.family)]) {
    if (family && !seen.has(family)) {
      seen.add(family);
      out.push(family);
    }
  }
  return out;
}

interface SettingsSelectOption {
  value: string;
  label: string;
}

function SettingsSelect({
  value,
  options,
  onChange,
  compact = false,
}: {
  value: string;
  options: readonly SettingsSelectOption[];
  onChange: (value: string) => void;
  compact?: boolean;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const selected = options.find((option) => option.value === value);
  const selectedLabel =
    selected?.label ?? (value ? `Missing: ${value}` : (options[0]?.label ?? ""));

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  return (
    <div className={`settings-select${compact ? " settings-select--compact" : ""}`} ref={ref}>
      <button
        type="button"
        className="settings-select__trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (event.key === "Escape") setOpen(false);
        }}
      >
        <span className="settings-select__label">{selectedLabel}</span>
        <IconChevronDown className="settings-select__caret" />
      </button>
      {open && (
        <div className="settings-select__dropdown">
          <ScrollFadeFrame
            frameClassName="settings-select__list-frame"
            className="settings-select__list"
            role="listbox"
            fill
          >
            {options.map((option) => {
              const active = option.value === value;
              return (
                <button
                  key={option.value}
                  type="button"
                  className={`settings-select__option${active ? " settings-select__option--active" : ""}`}
                  role="option"
                  aria-selected={active}
                  onClick={() => {
                    onChange(option.value);
                    setOpen(false);
                  }}
                >
                  <span className="settings-select__check">{active && <IconCheck />}</span>
                  <span className="settings-select__option-label">{option.label}</span>
                </button>
              );
            })}
          </ScrollFadeFrame>
        </div>
      )}
    </div>
  );
}

// Min/max mirror the AppSettingsSchema clamp for diffMaxFileSizeMiB
// ([1 KiB, 1 GiB]). Kept here so the input can report an out-of-range value
// before it ever reaches the store.
const DIFF_SIZE_MIN_MIB = 1 / 1024; // 1 KiB
const DIFF_SIZE_MAX_MIB = 1024; // 1 GiB

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function envToText(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
}

function parseEnvText(
  text: string,
): { ok: true; env: Record<string, string> } | { ok: false; error: string } {
  const env: Record<string, string> = {};
  const seen = new Set<string>();
  const lines = text.replace(/\r\n?/g, "\n").split("\n");

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i] ?? "";
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const eq = rawLine.indexOf("=");
    if (eq < 0) return { ok: false, error: `Line ${i + 1}: expected KEY=value.` };

    const name = rawLine.slice(0, eq).trim();
    const value = rawLine.slice(eq + 1);
    if (!ENV_NAME_RE.test(name)) {
      return { ok: false, error: `Line ${i + 1}: “${name}” is not a valid env name.` };
    }
    if (name.startsWith("PIVIS_")) {
      return { ok: false, error: `Line ${i + 1}: PIVIS_* variables are reserved.` };
    }
    if (seen.has(name)) return { ok: false, error: `Line ${i + 1}: duplicate “${name}”.` };
    seen.add(name);
    env[name] = value;
  }

  return { ok: true, env };
}

function PiEnvEditor({
  value,
  onCommit,
}: {
  value: Record<string, string>;
  onCommit: (env: Record<string, string>) => Promise<void>;
}): React.ReactElement {
  const savedText = envToText(value);
  const [text, setText] = useState(savedText);
  const [dirty, setDirty] = useState(false);
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!dirty) setText(savedText);
  }, [dirty, savedText]);

  const commit = async () => {
    const parsed = parseEnvText(text);
    if (!parsed.ok) {
      setMessage(parsed.error);
      return;
    }
    setSaving(true);
    setMessage("");
    try {
      await onCommit(parsed.env);
      setDirty(false);
      setMessage("Saved. Reload running sessions to pick up changes.");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="settings-env-editor">
      <textarea
        className="settings-input settings-textarea settings-textarea--env"
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setDirty(true);
          setMessage("");
        }}
        spellCheck={false}
        placeholder="ANTHROPIC_BASE_URL=https://…\nPI_AGENT_DIR=/path/to/agent"
        aria-label="Pi environment variables"
      />
      <div className="settings-env-editor__actions">
        <button type="button" className="settings-btn" onClick={commit} disabled={!dirty || saving}>
          {saving ? "Saving…" : "Apply"}
        </button>
        <button
          type="button"
          className="settings-btn"
          onClick={() => {
            setText("");
            setDirty(true);
            setMessage("");
          }}
          disabled={saving || (!dirty && !savedText)}
        >
          Clear
        </button>
        {message && (
          <span
            className={`settings-hint ${message.startsWith("Line ") ? "settings-hint--error" : ""}`}
          >
            {message}
          </span>
        )}
      </div>
      <span className="settings-hint">
        One <code>KEY=value</code> per line. These are merged into pi sessions and the login
        terminal; restart or <code>/reload</code> a session after changing them.
      </span>
    </div>
  );
}

/**
 * Freeform max-file-size input. Accepts sizes like "5 MiB", "500 KiB",
 * "1 GiB", or a bare number (read as MiB), validating on blur / Enter. The
 * stored value only updates on a valid, in-range commit; invalid input shows
 * an inline error and is not persisted. The user's text is preserved verbatim
 * once it round-trips to the stored value — we only normalize it when the
 * value is changed from outside this input.
 */
function DiffMaxSizeInput({
  valueMiB,
  onCommit,
}: {
  valueMiB: number;
  onCommit: (mib: number) => void;
}): React.ReactElement {
  const [text, setText] = useState(() => formatMiB(valueMiB));
  const [error, setError] = useState("");

  // Re-sync the box when the stored value changes. If it still matches what's
  // typed (the change came from this input's own commit), leave the text
  // exactly as entered — "1500 KiB" stays "1500 KiB" instead of snapping to
  // "1.46 MiB". Only a change from elsewhere normalizes the display.
  useEffect(() => {
    setText((cur) => {
      const parsed = parseSizeToMiB(cur);
      if (parsed !== null && Math.abs(parsed - valueMiB) < 1e-9) return cur;
      return formatMiB(valueMiB);
    });
    setError("");
  }, [valueMiB]);

  const commit = () => {
    const mib = parseSizeToMiB(text);
    if (mib === null) {
      setError("Enter a size like “5 MiB”, “500 KiB”, or “1 GiB”.");
      return;
    }
    if (mib < DIFF_SIZE_MIN_MIB || mib > DIFF_SIZE_MAX_MIB) {
      setError("Must be between 1 KiB and 1 GiB.");
      return;
    }
    setError("");
    // Persist the parsed value but keep the text as typed (the effect above
    // won't clobber it, since the new stored value round-trips from it).
    onCommit(mib);
  };

  return (
    <>
      <input
        className="settings-input"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          }
        }}
        placeholder="e.g. 5 MiB"
        aria-label="Maximum diff file size"
      />
      {error ? (
        <span className="settings-hint settings-hint--error">{error}</span>
      ) : (
        <span className="settings-hint">
          Files larger than this show a “too large” notice instead of a diff.
        </span>
      )}
    </>
  );
}

interface SettingsViewProps {
  onClose: () => void;
  initialSection?: "account" | undefined;
}

function isAppUpdateBusy(status: AppUpdateStatus | null): boolean {
  return status?.state === "checking" || status?.state === "available";
}

function appUpdateMessage(status: AppUpdateStatus): string {
  switch (status.state) {
    case "checking":
      return "Checking…";
    case "downloaded":
      return "Update ready to install";
    case "not-available":
      return "Pi-Vis is up to date";
    case "available":
      return "Update found; downloading…";
    case "disabled":
      return status.supported ? "App updates disabled" : "Available in signed macOS builds";
    case "error":
      return status.error ?? "Check failed";
    default:
      return "";
  }
}

function availableExtensionCount(status: ExtensionUpdateStatus | null): number {
  return status?.updates.filter((extension) => extension.updateAvailable).length ?? 0;
}

function extensionUpdateMessage(status: ExtensionUpdateStatus): string {
  const available = availableExtensionCount(status);
  if (status.updates.length === 0) return "No user extensions installed";
  if (available > 0) {
    return `${available} update${available === 1 ? "" : "s"} available`;
  }
  if (status.updates.some((extension) => extension.latestVersion === null)) {
    return "Installed extensions shown; latest versions unavailable";
  }
  return "All user extensions are up to date";
}

export function SettingsView({ onClose, initialSection }: SettingsViewProps): React.ReactElement {
  const { settings, update } = useSettingsStore();
  const [localFonts, setLocalFonts] = useState<FontFamily[]>([]);
  const [piInfo, setPiInfo] = useState<{ version: string } | null>(null);
  const [userThemesDir, setUserThemesDir] = useState("");
  const accountRef = useRef<HTMLElement>(null);

  // ── Auth state ─────────────────────────────────────────────────────────
  const [authProviders, setAuthProviders] = useState<ProviderAuthStatus[]>([]);
  const [newProviderKey, setNewProviderKey] = useState("");
  const [newApiKey, setNewApiKey] = useState("");
  const [showApiKey, setShowApiKey] = useState(false);
  const [authSaveMsg, setAuthSaveMsg] = useState("");
  const [showLoginTerminal, setShowLoginTerminal] = useState(false);
  const [initialAuthSnapshot, setInitialAuthSnapshot] = useState<ProviderAuthStatus[]>([]);

  // ── Update state ───────────────────────────────────────────────────────
  const appUpdateStatus = useAppUpdatesStore((s) => s.status);
  const setAppUpdateStatus = useAppUpdatesStore((s) => s.setStatus);
  const [appChecking, setAppChecking] = useState(false);
  const [appUpdateMsg, setAppUpdateMsg] = useState("");
  const extensionUpdateStatus = useExtensionUpdatesStore((s) => s.status);
  const extensionChecking = useExtensionUpdatesStore((s) => s.checking);
  const [extensionUpdating, setExtensionUpdating] = useState<string | null>(null);
  const [extensionUpdateMsg, setExtensionUpdateMsg] = useState("");
  const extensionAutoCheckStartedRef = useRef(false);

  // ── Load on mount ─────────────────────────────────────────────────────
  useEffect(() => {
    // Load local fonts if API available
    if ("queryLocalFonts" in window) {
      (window.queryLocalFonts as () => Promise<FontFamily[]>)()
        .then((fonts) => {
          const families = [...new Set(fonts.map((f) => f.family))].sort();
          setLocalFonts(families.map((f) => ({ family: f })));
        })
        .catch(() => {});
    }

    window.pivis
      .invoke("pi.info", undefined)
      .then(setPiInfo)
      .catch(() => {});

    // Load auth status
    window.pivis
      .invoke("auth.status", undefined)
      .then(setAuthProviders)
      .catch(() => {});

    window.pivis
      .invoke("appUpdate.status", undefined)
      .then(setAppUpdateStatus)
      .catch(() => {});

    window.pivis
      .invoke("themes.userDir", undefined)
      .then(setUserThemesDir)
      .catch(() => {});
  }, [setAppUpdateStatus]);

  // Subscribe to live auth changes
  useEffect(() => {
    const unsub = window.pivis.on("auth.changed", ({ providers }) => {
      setAuthProviders(providers);
    });
    return () => unsub();
  }, []);

  // Auto-scroll to Account section if initialSection is set
  useEffect(() => {
    if (initialSection === "account" && accountRef.current) {
      accountRef.current.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [initialSection]);

  // ── Auth handlers ─────────────────────────────────────────────────────

  const handleSaveApiKey = useCallback(async () => {
    if (!newProviderKey || !newApiKey.trim()) {
      setAuthSaveMsg("Select a provider and enter an API key");
      return;
    }
    const result = await window.pivis.invoke("auth.saveApiKey", {
      provider: newProviderKey,
      key: newApiKey.trim(),
    });
    if (result.ok) {
      setAuthSaveMsg("API key saved");
      setNewApiKey("");
      // Refresh status
      const providers = await window.pivis.invoke("auth.status", undefined);
      setAuthProviders(providers);
    } else {
      setAuthSaveMsg(result.error);
    }
  }, [newProviderKey, newApiKey]);

  const handleRemoveProvider = useCallback(async (provider: string) => {
    const result = await window.pivis.invoke("auth.remove", { provider });
    if (result.ok) {
      const providers = await window.pivis.invoke("auth.status", undefined);
      setAuthProviders(providers);
    }
  }, []);

  const handleOpenLogin = useCallback(() => {
    setInitialAuthSnapshot([...authProviders]);
    setShowLoginTerminal(true);
  }, [authProviders]);

  // ── Update helpers ──────────────────────────────────────────────────

  const handleCheckAppUpdate = useCallback(async () => {
    setAppChecking(true);
    setAppUpdateMsg("Checking…");
    try {
      const status = await window.pivis.invoke("appUpdate.check", undefined);
      setAppUpdateStatus(status);
      setAppUpdateMsg(appUpdateMessage(status));
      setAppChecking(isAppUpdateBusy(status));
    } catch {
      setAppUpdateMsg("Check failed");
      setAppChecking(false);
    }
  }, [setAppUpdateStatus]);

  const handleInstallAppUpdate = useCallback(() => {
    void window.pivis.invoke("appUpdate.install", undefined);
  }, []);

  const handleCheckExtensionUpdates = useCallback(async () => {
    setExtensionUpdateMsg("Checking…");
    try {
      const status = await checkExtensionUpdates();
      setExtensionUpdateMsg(extensionUpdateMessage(status));
    } catch {
      setExtensionUpdateMsg("Extension check failed");
    }
  }, []);

  const handleRunExtensionUpdate = useCallback(async (target: ExtensionUpdateTarget) => {
    const targetKey = target === "all" ? "all" : target.extension;
    setExtensionUpdating(targetKey);
    setExtensionUpdateMsg("Updating…");
    try {
      const result = await window.pivis.invoke("extensionUpdates.run", { target });
      if (result.exitCode !== 0) {
        setExtensionUpdateMsg(result.timedOut ? "Extension update timed out" : "Update failed");
        return;
      }
      const status = await checkExtensionUpdates();
      setExtensionUpdateMsg(
        status.updates.some((extension) => extension.updateAvailable)
          ? extensionUpdateMessage(status)
          : "Update completed; all extensions are up to date",
      );
    } catch {
      setExtensionUpdateMsg("Update failed");
    } finally {
      setExtensionUpdating(null);
    }
  }, []);

  // Restore the pre-pin behavior: opening Settings initiates extension
  // awareness when the delayed launch check has not already populated cache.
  // The renderer and main single-flight claims make Strict Mode and a launch
  // race join the same underlying package-manager pass.
  useEffect(() => {
    if (extensionAutoCheckStartedRef.current) return;
    extensionAutoCheckStartedRef.current = true;
    if (extensionUpdateStatus) {
      setExtensionUpdateMsg(extensionUpdateMessage(extensionUpdateStatus));
      return;
    }
    void handleCheckExtensionUpdates();
  }, [extensionUpdateStatus, handleCheckExtensionUpdates]);

  // Subscribe to app-update status changes
  useEffect(() => {
    const unsubAppUpdate = window.pivis.on("appUpdate.status", (status) => {
      setAppUpdateStatus(status);
      setAppChecking(isAppUpdateBusy(status));
      setAppUpdateMsg(appUpdateMessage(status));
    });
    return () => {
      unsubAppUpdate();
    };
  }, [setAppUpdateStatus]);

  const appUpdateBusy = appChecking || isAppUpdateBusy(appUpdateStatus);
  const installedExtensions = extensionUpdateStatus?.updates ?? [];
  const availableExtensions = installedExtensions.filter((extension) => extension.updateAvailable);
  const themes = listThemes();
  const lightThemeOptions = themes
    .filter((theme) => theme.appearance === "light")
    .map((theme) => ({ value: theme.id, label: theme.name }));
  const darkThemeOptions = themes
    .filter((theme) => theme.appearance === "dark")
    .map((theme) => ({ value: theme.id, label: theme.name }));
  const themeModeOptions: readonly { value: ThemeMode; label: string }[] = [
    { value: "light", label: "Light" },
    { value: "dark", label: "Dark" },
    { value: "system", label: "System" },
  ];
  const transcriptStyleOptions: readonly { value: TranscriptStyle; label: string }[] = [
    { value: "verbose", label: "Verbose" },
    { value: "compact", label: "Compact" },
  ];

  // ── Helper: source badge ─────────────────────────────────────────────

  const sourceBadge = (source: ProviderAuthStatus["source"]): { label: string; cls: string } => {
    switch (source) {
      case "api_key":
        return { label: "API key", cls: "badge--api-key" };
      case "oauth":
        return { label: "OAuth", cls: "badge--oauth" };
      case "environment":
        return { label: "via env", cls: "badge--env" };
      default:
        return { label: "none", cls: "" };
    }
  };

  return (
    <>
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: keyboard Escape is handled by the App-level effect */}
      <div
        className="settings-overlay"
        onClick={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
      >
        <div className="settings-panel">
          <div className="settings-panel__header">
            <span className="settings-panel__title">Settings</span>
            <button
              type="button"
              className="settings-panel__close icon-btn"
              onClick={onClose}
              aria-label="Close settings"
            >
              <IconClose />
            </button>
          </div>

          <ScrollFadeFrame
            frameClassName="settings-panel__body-frame"
            className="settings-panel__body"
            fill
          >
            {/* Pi runtime */}
            <section className="settings-section">
              <h3 className="settings-section__title">Pi runtime</h3>
              <div className="settings-row">
                <span className="settings-label">Version</span>
                <span className="settings-value settings-value--mono">
                  {piInfo?.version ?? "—"}
                </span>
                <span className="settings-hint">Bundled with Pi-Vis</span>
              </div>
            </section>

            {/* Pi environment */}
            <section className="settings-section">
              <h3 className="settings-section__title">Pi environment</h3>
              <PiEnvEditor value={settings.piEnv} onCommit={(piEnv) => update({ piEnv })} />
            </section>

            {/* Interface */}
            <section className="settings-section">
              <h3 className="settings-section__title">Interface</h3>
              <div className="settings-row">
                <span className="settings-label">Light theme</span>
                <SettingsSelect
                  value={settings.lightColorScheme}
                  onChange={(lightColorScheme) => update({ lightColorScheme })}
                  options={lightThemeOptions}
                />
              </div>
              <div className="settings-row">
                <span className="settings-label">Dark theme</span>
                <SettingsSelect
                  value={settings.darkColorScheme}
                  onChange={(darkColorScheme) => update({ darkColorScheme })}
                  options={darkThemeOptions}
                />
              </div>
              <div className="settings-row">
                <span className="settings-label">Mode</span>
                <div className="settings-segmented" role="group" aria-label="Theme mode">
                  {themeModeOptions.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      className={`settings-segmented__btn${
                        settings.themeMode === option.value
                          ? " settings-segmented__btn--active"
                          : ""
                      }`}
                      aria-pressed={settings.themeMode === option.value}
                      onClick={() => update({ themeMode: option.value })}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="settings-row">
                <span className="settings-label">Transcript</span>
                <div
                  className="settings-segmented settings-segmented--two"
                  role="group"
                  aria-label="Transcript style"
                >
                  {transcriptStyleOptions.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      className={`settings-segmented__btn${
                        settings.transcriptStyle === option.value
                          ? " settings-segmented__btn--active"
                          : ""
                      }`}
                      aria-pressed={settings.transcriptStyle === option.value}
                      onClick={() => update({ transcriptStyle: option.value })}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="settings-row">
                <span className="settings-label">Group models by provider</span>
                <button
                  type="button"
                  className={`settings-toggle ${settings.groupModelsByProvider ? "settings-toggle--on" : "settings-toggle--off"}`}
                  onClick={() => update({ groupModelsByProvider: !settings.groupModelsByProvider })}
                  aria-pressed={settings.groupModelsByProvider}
                >
                  <span className="settings-toggle__knob" />
                </button>
              </div>
              <div className="settings-row">
                <span className="settings-label">Saved session search</span>
                <button
                  type="button"
                  className={`settings-toggle ${settings.sessionSearchEnabled ? "settings-toggle--on" : "settings-toggle--off"}`}
                  onClick={() => update({ sessionSearchEnabled: !settings.sessionSearchEnabled })}
                  aria-label="Saved session search"
                  aria-describedby="saved-session-search-restart-hint"
                  aria-pressed={settings.sessionSearchEnabled}
                >
                  <span className="settings-toggle__knob" />
                </button>
                <span className="settings-hint" id="saved-session-search-restart-hint">
                  Takes effect after restarting Pi-Vis.
                </span>
              </div>
              <div className="settings-row">
                <span className="settings-label">Font Size</span>
                <div className="settings-stepper">
                  <button
                    type="button"
                    className="settings-stepper__btn"
                    onClick={() =>
                      update({
                        fonts: {
                          ...settings.fonts,
                          display: {
                            ...settings.fonts.display,
                            sizePx: Math.max(8, settings.fonts.display.sizePx - 1),
                          },
                        },
                      })
                    }
                  >
                    −
                  </button>
                  <span className="settings-stepper__val">{settings.fonts.display.sizePx}px</span>
                  <button
                    type="button"
                    className="settings-stepper__btn"
                    onClick={() =>
                      update({
                        fonts: {
                          ...settings.fonts,
                          display: {
                            ...settings.fonts.display,
                            sizePx: Math.min(32, settings.fonts.display.sizePx + 1),
                          },
                        },
                      })
                    }
                  >
                    +
                  </button>
                </div>
              </div>
              {userThemesDir && (
                <span className="settings-hint">
                  Drop custom theme <code>.json</code> files in <code>{userThemesDir}</code>, then
                  restart Pi-Vis.
                </span>
              )}
            </section>

            {/* Code */}
            <section className="settings-section">
              <h3 className="settings-section__title">Code</h3>
              <div className="settings-row">
                <span className="settings-label">Font Family</span>
                {localFonts.length > 0 ? (
                  <SettingsSelect
                    value={settings.fonts.code.family}
                    onChange={(family) =>
                      update({
                        fonts: {
                          ...settings.fonts,
                          code: { ...settings.fonts.code, family },
                        },
                      })
                    }
                    options={buildFontOptions(localFonts, settings.fonts.code.family).map(
                      (family) => ({ value: family, label: family }),
                    )}
                  />
                ) : (
                  <input
                    className="settings-input"
                    value={settings.fonts.code.family}
                    onChange={(e) =>
                      update({
                        fonts: {
                          ...settings.fonts,
                          code: { ...settings.fonts.code, family: e.target.value },
                        },
                      })
                    }
                  />
                )}
              </div>
              <div className="settings-row">
                <span className="settings-label">Font Size</span>
                <div className="settings-stepper">
                  <button
                    type="button"
                    className="settings-stepper__btn"
                    onClick={() =>
                      update({
                        fonts: {
                          ...settings.fonts,
                          code: {
                            ...settings.fonts.code,
                            sizePx: Math.max(8, settings.fonts.code.sizePx - 1),
                          },
                        },
                      })
                    }
                  >
                    −
                  </button>
                  <span className="settings-stepper__val">{settings.fonts.code.sizePx}px</span>
                  <button
                    type="button"
                    className="settings-stepper__btn"
                    onClick={() =>
                      update({
                        fonts: {
                          ...settings.fonts,
                          code: {
                            ...settings.fonts.code,
                            sizePx: Math.min(32, settings.fonts.code.sizePx + 1),
                          },
                        },
                      })
                    }
                  >
                    +
                  </button>
                </div>
              </div>
            </section>

            {/* Diff viewer */}
            <section className="settings-section">
              <h3 className="settings-section__title">Diff viewer</h3>
              <div className="settings-row">
                <span className="settings-label">Max file size</span>
                <DiffMaxSizeInput
                  valueMiB={settings.diffMaxFileSizeMiB}
                  onCommit={(mib) => update({ diffMaxFileSizeMiB: mib })}
                />
              </div>
            </section>

            {/* ── Account / Providers ──────────────────────────────────── */}
            <section ref={accountRef} className="settings-section" id="settings-account">
              <h3 className="settings-section__title">Account</h3>

              {/* Signed-in providers */}
              {authProviders.filter((p) => p.source !== "none").length > 0 && (
                <div className="settings-auth-list">
                  {authProviders
                    .filter((p) => p.source !== "none")
                    .map((p) => {
                      const badge = sourceBadge(p.source);
                      return (
                        <div key={p.key} className="settings-auth-row">
                          <span className="settings-auth-name">{p.displayName}</span>
                          <span className={`settings-auth-badge ${badge.cls}`}>{badge.label}</span>
                          {p.source !== "environment" && (
                            <button
                              type="button"
                              className="settings-btn settings-btn--small"
                              onClick={() => handleRemoveProvider(p.key)}
                            >
                              Sign out
                            </button>
                          )}
                          {p.source === "environment" && (
                            <span className="settings-hint">Managed via {p.envVar} env var</span>
                          )}
                        </div>
                      );
                    })}
                </div>
              )}

              {/* Add API key */}
              <div className="settings-auth-add">
                <span className="settings-label settings-label--inline">Add API key</span>
                <SettingsSelect
                  compact
                  value={newProviderKey}
                  onChange={setNewProviderKey}
                  options={[
                    { value: "", label: "Select provider…" },
                    ...PROVIDERS.filter((p) => !p.supportsOAuth).map((p) => ({
                      value: p.key,
                      label: p.displayName,
                    })),
                  ]}
                />
                <div className="settings-password-row">
                  <input
                    className="settings-input"
                    type={showApiKey ? "text" : "password"}
                    placeholder="sk-..."
                    value={newApiKey}
                    onChange={(e) => setNewApiKey(e.target.value)}
                  />
                  <button
                    type="button"
                    className="settings-btn"
                    onClick={() => setShowApiKey(!showApiKey)}
                    aria-label={showApiKey ? "Hide API key" : "Show API key"}
                  >
                    {showApiKey ? "Hide" : "Show"}
                  </button>
                </div>
                <button type="button" className="settings-btn" onClick={handleSaveApiKey}>
                  Save
                </button>
                {authSaveMsg && <span className="settings-hint">{authSaveMsg}</span>}
              </div>

              {/* OAuth / Subscription login */}
              <div className="settings-row">
                <span className="settings-hint">
                  Sign in with a subscription (Claude, ChatGPT, Copilot) using pi&apos;s built-in
                  OAuth flow.
                </span>
                <button type="button" className="settings-btn" onClick={handleOpenLogin}>
                  Sign in with a subscription
                </button>
              </div>
            </section>

            {/* ── Updates ──────────────────────────────────────────────── */}
            <section className="settings-section settings-section--updates">
              <h3 className="settings-section__title">Updates</h3>

              <div className="settings-row">
                <span className="settings-label">Pi-Vis app</span>
                <span className="settings-value--mono">
                  {appUpdateStatus?.currentVersion ?? "—"}
                </span>
                <button
                  type="button"
                  className="settings-btn"
                  onClick={
                    appUpdateStatus?.state === "downloaded"
                      ? handleInstallAppUpdate
                      : handleCheckAppUpdate
                  }
                  disabled={appUpdateBusy}
                >
                  {appUpdateStatus?.state === "downloaded"
                    ? "Restart to install"
                    : appUpdateStatus?.state === "available"
                      ? "Downloading…"
                      : appUpdateBusy
                        ? "Checking…"
                        : "Check app"}
                </button>
                {appUpdateMsg && <span className="settings-hint">{appUpdateMsg}</span>}
              </div>

              <div className="settings-row">
                <span className="settings-label">Check Pi-Vis automatically</span>
                <button
                  type="button"
                  className={`settings-toggle ${settings.appUpdateCheckEnabled ? "settings-toggle--on" : "settings-toggle--off"}`}
                  onClick={() => update({ appUpdateCheckEnabled: !settings.appUpdateCheckEnabled })}
                >
                  <span className="settings-toggle__knob" />
                </button>
              </div>

              <div className="settings-row">
                <span className="settings-label">Pi extensions</span>
                <button
                  type="button"
                  className="settings-btn"
                  onClick={handleCheckExtensionUpdates}
                  disabled={extensionChecking || extensionUpdating !== null}
                >
                  {extensionChecking ? "Checking…" : "Check extensions"}
                </button>
                {extensionUpdateMsg && <span className="settings-hint">{extensionUpdateMsg}</span>}
              </div>

              <div className="settings-row">
                <span className="settings-label">Check extensions automatically</span>
                <button
                  type="button"
                  className={`settings-toggle ${settings.extensionUpdateCheckEnabled ? "settings-toggle--on" : "settings-toggle--off"}`}
                  onClick={() =>
                    update({
                      extensionUpdateCheckEnabled: !settings.extensionUpdateCheckEnabled,
                    })
                  }
                >
                  <span className="settings-toggle__knob" />
                </button>
              </div>

              {extensionUpdateStatus && (
                <div className="settings-extension-updates" aria-live="polite">
                  <div className="settings-extension-updates__header">
                    <div className="settings-extension-updates__heading">
                      <span className="settings-extension-updates__title">
                        Installed extensions
                      </span>
                      <span className="settings-hint">{installedExtensions.length} installed</span>
                    </div>
                    {availableExtensions.length > 1 && (
                      <button
                        type="button"
                        className="settings-btn settings-btn--small"
                        disabled={extensionUpdating !== null}
                        onClick={() => void handleRunExtensionUpdate("all")}
                      >
                        {extensionUpdating === "all" ? "Updating…" : "Update all"}
                      </button>
                    )}
                  </div>
                  {installedExtensions.length > 0 ? (
                    <>
                      <div className="settings-extension-updates__columns" aria-hidden="true">
                        <span>Extension</span>
                        <span>Current</span>
                        <span>Latest</span>
                        <span />
                      </div>
                      {installedExtensions.map((extension) => (
                        <div className="settings-extension-update" key={extension.source}>
                          <div className="settings-extension-update__details">
                            <FadeText
                              className="settings-extension-update__name"
                              title={extension.source}
                            >
                              {extension.displayName}
                            </FadeText>
                            <span className="settings-hint">{extension.type}</span>
                          </div>
                          <span
                            className="settings-extension-update__version"
                            title={extension.currentVersion ?? undefined}
                          >
                            {extension.currentVersion ?? "Unknown"}
                          </span>
                          <span
                            className={`settings-extension-update__version settings-extension-update__version--latest${extension.updateAvailable ? " settings-extension-update__version--new" : ""}`}
                            title={extension.latestVersion ?? undefined}
                          >
                            {extension.latestVersion ?? "Unavailable"}
                          </span>
                          {extension.updateAvailable ? (
                            <button
                              type="button"
                              className="settings-btn settings-btn--small"
                              aria-label={`Update ${extension.displayName}`}
                              disabled={extensionUpdating !== null}
                              onClick={() =>
                                void handleRunExtensionUpdate({ extension: extension.source })
                              }
                            >
                              {extensionUpdating === extension.source ? "Updating…" : "Update"}
                            </button>
                          ) : (
                            <span className="settings-extension-update__status">Up to date</span>
                          )}
                        </div>
                      ))}
                    </>
                  ) : (
                    <p className="settings-extension-updates__empty">
                      No user extensions installed.
                    </p>
                  )}
                </div>
              )}
            </section>
          </ScrollFadeFrame>
        </div>
      </div>

      {/* Login terminal modal */}
      {showLoginTerminal && (
        <LoginTerminal
          initialAuthStatus={initialAuthSnapshot}
          onClose={() => setShowLoginTerminal(false)}
        />
      )}

      {/* Update progress modal — owned by App.tsx */}
    </>
  );
}
