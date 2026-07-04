import type { AppUpdateStatus } from "@shared/app-updates.js";
import type { ProviderAuthStatus } from "@shared/auth.js";
import { PROVIDERS } from "@shared/auth.js";
import type { UpdateStatus } from "@shared/updates.js";
import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { formatMiB, parseSizeToMiB } from "../../lib/file-size.js";
import { useAppUpdatesStore } from "../../stores/app-updates-store.js";
import { useSettingsStore } from "../../stores/settings-store.js";
import { useUpdatesStore } from "../../stores/updates-store.js";
import { listThemes } from "../../theme/registry.js";
import { LoginTerminal } from "../auth/LoginTerminal.js";
import { IconCheck, IconClose } from "../common/icons.js";
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

export function SettingsView({ onClose, initialSection }: SettingsViewProps): React.ReactElement {
  const { settings, update } = useSettingsStore();
  const [localFonts, setLocalFonts] = useState<FontFamily[]>([]);
  const [piInfo, setPiInfo] = useState<{ path: string; version: string } | null>(null);
  const [userThemesDir, setUserThemesDir] = useState("");
  const [recheckMsg, setRecheckMsg] = useState("");
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
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null);
  const [updateCheckMsg, setUpdateCheckMsg] = useState("");
  const updatesStatus = useUpdatesStore((s) => s.status);
  const setStatus = useUpdatesStore((s) => s.setStatus);
  const setActiveRun = useUpdatesStore((s) => s.setActiveRun);
  const [checking, setChecking] = useState(false);
  const appUpdateStatus = useAppUpdatesStore((s) => s.status);
  const setAppUpdateStatus = useAppUpdatesStore((s) => s.setStatus);
  const [appChecking, setAppChecking] = useState(false);
  const [appUpdateMsg, setAppUpdateMsg] = useState("");

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
      .invoke("pi.locate", undefined)
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

  // Seed update status from store on mount, auto-check if stale
  useEffect(() => {
    if (updatesStatus) {
      setUpdateStatus(updatesStatus);
    }
    // Auto-check on mount if no status yet
    if (!updatesStatus) {
      setChecking(true);
      window.pivis
        .invoke("update.check", undefined)
        .then((status) => {
          setUpdateStatus(status);
          setStatus(status);
          setUpdateCheckMsg("");
        })
        .catch(() => {
          setUpdateCheckMsg("Check failed");
        })
        .finally(() => {
          setChecking(false);
        });
    }
  }, [setStatus, updatesStatus]);

  // ── Pi recheck ────────────────────────────────────────────────────────

  const handleRecheck = async () => {
    setRecheckMsg("Checking…");
    const info = await window.pivis.invoke("pi.locate", undefined);
    setPiInfo(info);
    setRecheckMsg(info ? `Found: ${info.path}` : "Not found");
  };

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

  const fmtTimeAgo = (ts: number): string => {
    const sec = Math.round((Date.now() - ts) / 1000);
    if (sec < 60) return `${sec}s ago`;
    const min = Math.round(sec / 60);
    if (min < 60) {
      if (min === 1) return "1m ago";
      return `${min}m ago`;
    }
    const hr = Math.round(min / 60);
    if (hr < 24) return `${hr}h ago`;
    return `${Math.round(hr / 24)}d ago`;
  };

  const handleCheckUpdates = useCallback(async () => {
    setChecking(true);
    setUpdateCheckMsg("Checking…");
    try {
      const status = await window.pivis.invoke("update.check", undefined);
      setUpdateStatus(status);
      setStatus(status);
      setUpdateCheckMsg("");
    } catch (err) {
      setUpdateCheckMsg("Check failed");
    } finally {
      setChecking(false);
    }
  }, [setStatus]);

  const handleRunUpdate = useCallback(
    (target: "all" | "pi" | { extension: string }) => {
      void (async () => {
        const { runId } = await window.pivis.invoke("update.run", { target });
        setActiveRun({ runId, lines: [] });
      })();
    },
    [setActiveRun],
  );

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

  // Subscribe to update completion
  useEffect(() => {
    const unsubDone = window.pivis.on("update.done", ({ runId, exitCode, status }) => {
      setUpdateStatus(status);
      setStatus(status);
      setUpdateCheckMsg(exitCode === 0 ? "Update successful" : "Update failed");
    });
    const unsubAppUpdate = window.pivis.on("appUpdate.status", (status) => {
      setAppUpdateStatus(status);
      setAppChecking(isAppUpdateBusy(status));
      setAppUpdateMsg(appUpdateMessage(status));
    });
    return () => {
      unsubDone();
      unsubAppUpdate();
    };
  }, [setAppUpdateStatus, setStatus]);

  const appUpdateBusy = appChecking || isAppUpdateBusy(appUpdateStatus);

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

          <div className="settings-panel__body">
            {/* Pi binary */}
            <section className="settings-section">
              <h3 className="settings-section__title">pi binary</h3>
              <div className="settings-row">
                <span className="settings-label">Path</span>
                <span className="settings-value settings-value--mono">
                  {piInfo?.path ?? "not found"}
                </span>
                <button type="button" className="settings-btn" onClick={handleRecheck}>
                  Re-detect
                </button>
                {recheckMsg && <span className="settings-hint">{recheckMsg}</span>}
              </div>
              {piInfo && (
                <div className="settings-row">
                  <span className="settings-label">Version</span>
                  <span className="settings-value settings-value--mono">{piInfo.version}</span>
                </div>
              )}
            </section>

            {/* Pi environment */}
            <section className="settings-section">
              <h3 className="settings-section__title">Pi environment</h3>
              <PiEnvEditor value={settings.piEnv} onCommit={(piEnv) => update({ piEnv })} />
            </section>

            {/* Color scheme */}
            <section className="settings-section">
              <h3 className="settings-section__title">Color scheme</h3>
              <div className="settings-row">
                <span className="settings-label">Theme</span>
                <select
                  className="settings-select"
                  value={settings.colorScheme}
                  onChange={(e) => update({ colorScheme: e.target.value })}
                >
                  {listThemes().map((theme) => (
                    <option key={theme.id} value={theme.id}>
                      {theme.name} ({theme.appearance})
                    </option>
                  ))}
                </select>
              </div>
              {userThemesDir && (
                <span className="settings-hint">
                  Drop custom theme <code>.json</code> files in <code>{userThemesDir}</code>, then
                  restart Pi-Vis.
                </span>
              )}
            </section>

            {/* Interface font */}
            <section className="settings-section">
              <h3 className="settings-section__title">Interface font</h3>
              <div className="settings-row">
                <span className="settings-label">Size</span>
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
              <span className="settings-hint">
                Pi-Vis owns interface font families for stable alignment; adjust size here for
                readability.
              </span>
            </section>

            {/* Code font */}
            <section className="settings-section">
              <h3 className="settings-section__title">Code font</h3>
              <div className="settings-row">
                <span className="settings-label">Family</span>
                {localFonts.length > 0 ? (
                  <select
                    className="settings-select"
                    value={settings.fonts.code.family}
                    onChange={(e) =>
                      update({
                        fonts: {
                          ...settings.fonts,
                          code: { ...settings.fonts.code, family: e.target.value },
                        },
                      })
                    }
                  >
                    {buildFontOptions(localFonts, settings.fonts.code.family).map((family) => (
                      <option key={family} value={family}>
                        {family}
                      </option>
                    ))}
                  </select>
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
                <span className="settings-label">Size</span>
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
                <select
                  className="settings-select settings-select--compact"
                  value={newProviderKey}
                  onChange={(e) => setNewProviderKey(e.target.value)}
                >
                  <option value="">Select provider…</option>
                  {PROVIDERS.filter((p) => !p.supportsOAuth).map((p) => (
                    <option key={p.key} value={p.key}>
                      {p.displayName}
                    </option>
                  ))}
                </select>
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
            <section className="settings-section">
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
                <span className="settings-label">Check Pi-Vis on launch</span>
                <button
                  type="button"
                  className={`settings-toggle ${settings.appUpdateCheckEnabled ? "settings-toggle--on" : "settings-toggle--off"}`}
                  onClick={() => update({ appUpdateCheckEnabled: !settings.appUpdateCheckEnabled })}
                >
                  <span className="settings-toggle__knob" />
                </button>
              </div>

              {/* Last checked indicator */}
              {updateStatus && (
                <div className="settings-update-meta">
                  <span className="settings-hint">
                    Last checked {fmtTimeAgo(updateStatus.checkedAt)}
                  </span>
                  {checking && (
                    <span className="settings-hint settings-hint--checking">Checking…</span>
                  )}
                </div>
              )}

              {/* Legend header */}
              <div className="settings-update-header">
                <span className="settings-update-col-pkg">Package</span>
                <span className="settings-update-col-current">Installed</span>
                <span className="settings-update-col-target">Latest</span>
                <span className="settings-update-col-action">Status</span>
              </div>

              {/* pi row */}
              {(() => {
                const st = updateStatus?.pi;
                const current = st?.current ?? piInfo?.version;
                const latest = st?.latest;
                const available = st?.updateAvailable === true;
                const upToDate = st && !available && current != null;
                return (
                  <div
                    key="pi"
                    className={`settings-update-row ${available ? "settings-update-row--actionable" : "settings-update-row--uptodate"}`}
                  >
                    <span className="settings-update-col-pkg settings-update-col-pkg--pi">pi</span>
                    <span className="settings-update-col-current settings-value--mono">
                      {current ?? "—"}
                    </span>
                    <span className="settings-update-col-target settings-value--mono">
                      {available && latest ? latest : "—"}
                    </span>
                    <span className="settings-update-col-action">
                      {checking ? (
                        <span className="settings-update-badge settings-update-badge--checking">
                          …
                        </span>
                      ) : available ? (
                        <button
                          type="button"
                          className="settings-btn"
                          onClick={() => handleRunUpdate("pi")}
                        >
                          Update
                        </button>
                      ) : current ? (
                        <span className="settings-update-badge settings-update-badge--ok">
                          <IconCheck /> Up to date
                        </span>
                      ) : (
                        <span className="settings-update-badge settings-update-badge--na">
                          Unknown
                        </span>
                      )}
                    </span>
                  </div>
                );
              })()}

              {/* Extension rows */}
              {updateStatus?.extensions.map((ext) => {
                const available = ext.updateAvailable && ext.latest != null;
                const upToDate = !ext.updateAvailable && ext.current != null;
                const isLocal = ext.kind === "local";
                return (
                  <div
                    key={ext.source}
                    className={`settings-update-row ${available ? "settings-update-row--actionable" : upToDate ? "settings-update-row--uptodate" : "settings-update-row--unknown"}`}
                  >
                    <span className="settings-update-col-pkg">{ext.name}</span>
                    <span className="settings-update-col-current settings-value--mono">
                      {ext.current ?? "—"}
                    </span>
                    <span className="settings-update-col-target settings-value--mono">
                      {available && ext.latest ? ext.latest : "—"}
                    </span>
                    <span className="settings-update-col-action">
                      {isLocal ? (
                        <span className="settings-update-badge settings-update-badge--local">
                          Local
                        </span>
                      ) : available ? (
                        <button
                          type="button"
                          className="settings-btn"
                          onClick={() => handleRunUpdate({ extension: ext.source })}
                        >
                          Update
                        </button>
                      ) : upToDate ? (
                        <span className="settings-update-badge settings-update-badge--ok">
                          <IconCheck /> Up to date
                        </span>
                      ) : (
                        <span className="settings-update-badge settings-update-badge--na">
                          Not installed
                        </span>
                      )}
                    </span>
                  </div>
                );
              })}

              <div className="settings-row" style={{ marginTop: "0.571rem" }}>
                <button
                  type="button"
                  className="settings-btn"
                  onClick={handleCheckUpdates}
                  disabled={checking}
                >
                  {checking ? "Checking…" : "Check now"}
                </button>
                <button
                  type="button"
                  className="settings-btn"
                  onClick={() => handleRunUpdate("all")}
                  disabled={
                    !updateStatus ||
                    (!updateStatus.pi.updateAvailable &&
                      !updateStatus.extensions.some((e) => e.updateAvailable))
                  }
                >
                  Update all
                </button>
                {updateCheckMsg && <span className="settings-hint">{updateCheckMsg}</span>}
              </div>

              <div className="settings-row">
                <span className="settings-label">Check pi/extensions on launch</span>
                <button
                  type="button"
                  className={`settings-toggle ${settings.updateCheckEnabled ? "settings-toggle--on" : "settings-toggle--off"}`}
                  onClick={() => update({ updateCheckEnabled: !settings.updateCheckEnabled })}
                >
                  <span className="settings-toggle__knob" />
                </button>
              </div>
            </section>
          </div>
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
