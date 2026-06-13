import type React from "react";
import { useEffect, useState } from "react";
import { useSettingsStore } from "../../stores/settings-store.js";
import "./SettingsView.css";

interface FontFamily {
  family: string;
  fullName?: string;
}

export function SettingsView({ onClose }: { onClose: () => void }): React.ReactElement {
  const { settings, update } = useSettingsStore();
  const [localFonts, setLocalFonts] = useState<FontFamily[]>([]);
  const [piInfo, setPiInfo] = useState<{ path: string; version: string } | null>(null);
  const [recheckMsg, setRecheckMsg] = useState("");

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
  }, []);

  const handleRecheck = async () => {
    setRecheckMsg("Checking…");
    const info = await window.pivis.invoke("pi.locate", undefined);
    setPiInfo(info);
    setRecheckMsg(info ? `Found: ${info.path}` : "Not found");
  };

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard Escape is handled by the App-level effect
    <div
      className="settings-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="settings-panel">
        <div className="settings-panel__header">
          <span className="settings-panel__title">Settings</span>
          <button type="button" className="settings-panel__close" onClick={onClose}>
            ×
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

          {/* Display font */}
          <section className="settings-section">
            <h3 className="settings-section__title">Display font</h3>
            <div className="settings-row">
              <span className="settings-label">Family</span>
              {localFonts.length > 0 ? (
                <select
                  className="settings-select"
                  value={settings.fonts.display.family}
                  onChange={(e) =>
                    update({
                      fonts: {
                        ...settings.fonts,
                        display: { ...settings.fonts.display, family: e.target.value },
                      },
                    })
                  }
                >
                  {localFonts.map((f) => (
                    <option key={f.family} value={f.family}>
                      {f.family}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  className="settings-input"
                  value={settings.fonts.display.family}
                  onChange={(e) =>
                    update({
                      fonts: {
                        ...settings.fonts,
                        display: { ...settings.fonts.display, family: e.target.value },
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
                  {localFonts.map((f) => (
                    <option key={f.family} value={f.family}>
                      {f.family}
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

          {/* Providers / Login */}
          <section className="settings-section">
            <h3 className="settings-section__title">Providers &amp; Login</h3>
            <p className="settings-hint">
              Authentication happens in the terminal: run <code>pi</code> once and use{" "}
              <code>/login</code> there. Credentials are saved to <code>~/.pi/agent/auth.json</code>{" "}
              and shared with Pi-Vis automatically.
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}
