import type { SessionId } from "@shared/ids.js";
import type { ModelInfo, SessionStats } from "@shared/pi-protocol/responses.js";
import { ModelInfoSchema, SessionStatsSchema } from "@shared/pi-protocol/responses.js";
import {
  THINKING_LEVELS,
  type ThinkingLevel,
  ThinkingLevelSchema,
} from "@shared/pi-protocol/thinking.js";
import type React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatCost, formatTokens } from "../../lib/format.js";
import { useSessionsStore } from "../../stores/sessions-store.js";
import { useSettingsStore } from "../../stores/settings-store.js";
import "./SessionHeader.css";

interface SessionHeaderProps {
  sessionId: SessionId;
}

function highlightMatch(text: string, query: string): React.ReactNode {
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return text;
  return (
    <>
      {text.slice(0, idx)}
      <mark className="session-header__match">{text.slice(idx, idx + query.length)}</mark>
      {text.slice(idx + query.length)}
    </>
  );
}

export function SessionHeader({ sessionId }: SessionHeaderProps): React.ReactElement {
  const sessions = useSessionsStore((s) => s.sessions);
  const setAvailableModels = useSessionsStore((s) => s.setAvailableModels);
  const setCurrentModel = useSessionsStore((s) => s.setCurrentModel);
  const setStats = useSessionsStore((s) => s.setStats);
  const setSessionName = useSessionsStore((s) => s.setSessionName);
  const refreshWorkspaceSessions = useSessionsStore((s) => s.refreshWorkspaceSessions);
  const setThinkingLevel = useSessionsStore((s) => s.setThinkingLevel);
  const addToast = useSessionsStore((s) => s.addToast);
  const { settings, update: updateSettings } = useSettingsStore();

  const session = sessions.get(sessionId);
  const [editingName, setEditingName] = useState(false);
  const [nameInput, setNameInput] = useState("");
  const [modelOpen, setModelOpen] = useState(false);
  const [modelSearch, setModelSearch] = useState("");
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const [thinkingOpen, setThinkingOpen] = useState(false);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const thinkingDropdownRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Map<number, HTMLButtonElement>>(new Map());

  const modelAppliedRef = useRef(false);
  // The thinking level the user most recently asked for, awaiting confirmation
  // from pi (via a `thinking_level_changed` event or a `get_state` response).
  // When the authoritative level differs, we surface a toast explaining the
  // coercion. The dropdown itself always reflects what pi reports.
  const lastRequestedThinkingLevelRef = useRef<ThinkingLevel | null>(null);

  // Load models and apply last-used model preference
  useEffect(() => {
    modelAppliedRef.current = false;
    window.pivis
      .invoke("session.sendCommand", {
        sessionId,
        command: { type: "get_available_models" },
      })
      .then((res) => {
        const raw = res.data as { models?: unknown[]; currentModelId?: string } | undefined;
        const list = Array.isArray(raw?.models) ? raw.models : [];
        const models = list
          .map((m) => {
            const r = ModelInfoSchema.safeParse(m);
            return r.success ? r.data : null;
          })
          .filter((m): m is ModelInfo => m !== null);
        setAvailableModels(sessionId, models);

        if (modelAppliedRef.current) return;
        modelAppliedRef.current = true;

        // Prefer last-used model from settings, fall back to pi's current
        const lum = settings.lastUsedModel;
        const match = lum ? models.find((m) => m.id === lum.modelId) : undefined;

        if (match?.provider) {
          window.pivis
            .invoke("session.sendCommand", {
              sessionId,
              command: { type: "set_model", provider: match.provider, modelId: match.id },
            })
            .then(() => setCurrentModel(sessionId, match.id))
            .catch(() => {});
        } else if (raw?.currentModelId) {
          setCurrentModel(sessionId, raw.currentModelId);
        } else {
          const active = models.find((m) => (m as Record<string, unknown>)["current"] === true);
          if (active) setCurrentModel(sessionId, active.id);
        }
      })
      .catch(() => {});
  }, [sessionId, settings.lastUsedModel, setAvailableModels, setCurrentModel]);

  // Authoritative state on mount / session switch: seed the store with pi's
  // current model and thinking level. This makes the dropdown match pi even
  // before any user interaction or `thinking_level_changed` event arrives.
  useEffect(() => {
    let cancelled = false;
    void window.pivis
      .invoke("session.sendCommand", { sessionId, command: { type: "get_state" } })
      .then((res) => {
        if (cancelled) return;
        const raw = res?.data as { thinkingLevel?: unknown; model?: { id?: unknown }; sessionName?: unknown } | undefined;
        if (!raw) return;
        if (typeof raw.thinkingLevel === "string") {
          const parsed = ThinkingLevelSchema.safeParse(raw.thinkingLevel);
          if (parsed.success) {
            setThinkingLevel(sessionId, parsed.data);
          }
        }
        if (raw.model && typeof raw.model.id === "string") {
          setCurrentModel(sessionId, raw.model.id);
        }
        if (typeof raw.sessionName === "string" && raw.sessionName) {
          setSessionName(sessionId, raw.sessionName);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [sessionId, setThinkingLevel, setCurrentModel, setSessionName]);

  // Poll stats after each agent_end and periodically while streaming
  const sessionFileRegisteredRef = useRef(false);
  // Use a ref so the polling callback always sees fresh settings without restarting the interval
  const openSessionsRef = useRef(settings.openSessions);
  useEffect(() => {
    openSessionsRef.current = settings.openSessions;
  }, [settings.openSessions]);
  useEffect(() => {
    sessionFileRegisteredRef.current = false;
  }, [sessionId]);

  useEffect(() => {
    const workspacePath = session?.workspacePath;
    const fetchStats = () => {
      window.pivis
        .invoke("session.sendCommand", {
          sessionId,
          command: { type: "get_session_stats" },
        })
        .then((res) => {
          if (res.success && res.data) {
            const parsed = SessionStatsSchema.safeParse(res.data);
            if (parsed.success) {
              setStats(sessionId, parsed.data as SessionStats);

              // Register this session's file in openSessions once we learn it
              const file = parsed.data.sessionFile;
              if (file && workspacePath && !sessionFileRegisteredRef.current) {
                sessionFileRegisteredRef.current = true;
                void updateSettings({
                  openSessions: [
                    { workspacePath, sessionFile: file },
                    ...(openSessionsRef.current ?? []).filter(
                      (s) => !(s.workspacePath === workspacePath && s.sessionFile === file),
                    ),
                  ],
                });
              }
            }
          }
        })
        .catch(() => {});
    };

    fetchStats();
    const interval = setInterval(fetchStats, 60_000);
    return () => clearInterval(interval);
  }, [sessionId, session?.workspacePath, setStats, updateSettings]);

  // Listen for agent_end to refresh stats
  useEffect(() => {
    return window.pivis.on("session.event", ({ sessionId: sid, event }) => {
      if (sid === sessionId && event.type === "agent_end") {
        window.pivis
          .invoke("session.sendCommand", {
            sessionId,
            command: { type: "get_session_stats" },
          })
          .then((res) => {
            if (res.success && res.data) {
              const parsed = SessionStatsSchema.safeParse(res.data);
              if (parsed.success) setStats(sessionId, parsed.data as SessionStats);
            }
          })
          .catch(() => {});
      }
    });
  }, [sessionId, setStats]);

  // Focus search input and reset state when dropdown opens
  useEffect(() => {
    if (!modelOpen) {
      setModelSearch("");
      setHighlightedIndex(0);
      return;
    }
    setModelSearch("");
    setHighlightedIndex(0);
    setTimeout(() => searchInputRef.current?.focus(), 10);
  }, [modelOpen]);

  const filteredModels = (session?.availableModels ?? []).filter((m) => {
    const q = modelSearch.toLowerCase();
    if (!q) return true;
    return (m.name ?? m.id).toLowerCase().includes(q) || m.id.toLowerCase().includes(q);
  });

  // Reset highlight when search/filter changes
  useEffect(() => {
    setHighlightedIndex(0);
  }, [modelSearch]);

  // Scroll highlighted item into view
  useEffect(() => {
    if (!modelOpen) return;
    const btn = itemRefs.current.get(highlightedIndex);
    btn?.scrollIntoView({ block: "nearest" });
  }, [highlightedIndex, modelOpen]);

  // Close dropdown on outside click
  useEffect(() => {
    if (!modelOpen) return;
    const onMouseDown = (e: MouseEvent) => {
      if (!dropdownRef.current?.contains(e.target as Node)) {
        setModelOpen(false);
      }
    };
    document.addEventListener("mousedown", onMouseDown, true);
    return () => document.removeEventListener("mousedown", onMouseDown, true);
  }, [modelOpen]);

  // Close thinking dropdown on outside click
  useEffect(() => {
    if (!thinkingOpen) return;
    const onMouseDown = (e: MouseEvent) => {
      if (!thinkingDropdownRef.current?.contains(e.target as Node)) {
        setThinkingOpen(false);
      }
    };
    document.addEventListener("mousedown", onMouseDown, true);
    return () => document.removeEventListener("mousedown", onMouseDown, true);
  }, [thinkingOpen]);

  const handleModelChange = useCallback(
    async (model: ModelInfo) => {
      setModelOpen(false);
      if (!model.provider) return;
      try {
        await window.pivis.invoke("session.sendCommand", {
          sessionId,
          command: { type: "set_model", provider: model.provider, modelId: model.id },
        });
        setCurrentModel(sessionId, model.id);
        void updateSettings({ lastUsedModel: { provider: model.provider, modelId: model.id } });
      } catch (err) {
        console.error("Failed to set model:", err);
      }
    },
    [sessionId, setCurrentModel, updateSettings],
  );

  const handleThinkingLevel = useCallback(
    async (level: string) => {
      const parsed = ThinkingLevelSchema.safeParse(level);
      if (!parsed.success) return;
      const validated: ThinkingLevel = parsed.data;
      // Remember what the user asked for so the toast effect can compare it
      // against what pi actually applied. We can't rely solely on the effect
      // because if pi coerces the value back to the *current* level (e.g.
      // requesting "xhigh" while already on "high"), the store value never
      // changes and the effect would never fire.
      lastRequestedThinkingLevelRef.current = validated;
      try {
        await window.pivis.invoke("session.sendCommand", {
          sessionId,
          command: { type: "set_thinking_level", level: validated },
        });
        // Re-fetch authoritative state. Pi may have silently clamped the
        // requested level to one the current model supports (e.g. xhigh -> high).
        // Relying on the event alone misses the case where the effective level
        // is unchanged, so get_state is the safety net for the dropdown.
        const res = await window.pivis.invoke("session.sendCommand", {
          sessionId,
          command: { type: "get_state" },
        });
        const raw = res?.data as { thinkingLevel?: unknown } | undefined;
        if (raw && typeof raw.thinkingLevel === "string") {
          const confirmed = ThinkingLevelSchema.safeParse(raw.thinkingLevel);
          if (confirmed.success) {
            setThinkingLevel(sessionId, confirmed.data);
            // Surface the coercion here, not via the effect, so the case
            // where the confirmed value equals the current value still
            // produces a toast (the store didn't change, the effect won't run).
            if (confirmed.data !== validated) {
              addToast(
                sessionId,
                `Model does not support thinking level: ${validated} — using ${confirmed.data} instead.`,
                "warning",
              );
            }
          }
        }
        lastRequestedThinkingLevelRef.current = null;
      } catch (err) {
        console.error("Failed to set thinking level:", err);
        addToast(sessionId, `Failed to set thinking level: ${String(err)}`, "error");
        lastRequestedThinkingLevelRef.current = null;
      }
    },
    [sessionId, setThinkingLevel, addToast],
  );

  // The toast for a coerced thinking level is surfaced directly in
  // `handleThinkingLevel` after `get_state` confirms what pi applied. The
  // race against the `thinking_level_changed` event is resolved there too:
  // whichever path lands first clears the ref, so the other path won't
  // show a second toast. This effect only exists to clear the ref if pi
  // emits the event without a corresponding user-initiated request.
  useEffect(() => {
    if (session?.thinkingLevel == null) return;
    if (lastRequestedThinkingLevelRef.current != null) {
      lastRequestedThinkingLevelRef.current = null;
    }
  }, [session?.thinkingLevel]);

  // The model in the store is just an id; the dropdown's option set is
  // derived from the model record in `availableModels`. Pi does not expose
  // a per-model thinkingLevelMap over the wire, so the safe defaults are:
  //   - non-reasoning models: only "off" is meaningful
  //   - reasoning / unknown:  all universal levels (coercion + toast handle the rest)
  const currentModelInfo = useMemo<ModelInfo | undefined>(
    () => (session?.availableModels ?? []).find((m) => m.id === session?.currentModel),
    [session?.availableModels, session?.currentModel],
  );
  const thinkingOptions: readonly ThinkingLevel[] = useMemo(() => {
    if (currentModelInfo?.reasoning === false) {
      return ["off"];
    }
    return THINKING_LEVELS;
  }, [currentModelInfo]);
  const thinkingDisabled = thinkingOptions.length <= 1;

  const handleRenameStart = useCallback(() => {
    setNameInput(session?.sessionName ?? session?.sessionTitle ?? "");
    setEditingName(true);
    setTimeout(() => nameInputRef.current?.focus(), 10);
  }, [session]);

  const handleRenameConfirm = useCallback(async () => {
    if (nameInput.trim()) {
      try {
        await window.pivis.invoke("session.sendCommand", {
          sessionId,
          command: { type: "set_session_name", name: nameInput.trim() },
        });
        setSessionName(sessionId, nameInput.trim());
        if (session?.workspacePath) {
          void refreshWorkspaceSessions(session.workspacePath);
        }
      } catch (err) {
        console.error("Failed to set session name:", err);
      }
    }
    setEditingName(false);
  }, [nameInput, sessionId, setSessionName, refreshWorkspaceSessions, session?.workspacePath]);

  const stats = session?.stats;
  const contextPct =
    stats?.contextUsage?.percent != null ? Math.round(stats.contextUsage.percent) : null;

  return (
    <div className="session-header">
      {/* Session name */}
      <div className="session-header__name">
        {editingName ? (
          <input
            ref={nameInputRef}
            className="session-header__name-input"
            value={nameInput}
            onChange={(e) => setNameInput(e.target.value)}
            onBlur={() => void handleRenameConfirm()}
            onKeyDown={(e) => {
              if (e.key === "Enter") void handleRenameConfirm();
              if (e.key === "Escape") setEditingName(false);
            }}
          />
        ) : (
          <button className="session-header__name-btn" onClick={handleRenameStart}>
            {session?.sessionName ?? session?.sessionTitle ?? "Untitled session"}
          </button>
        )}
      </div>

      <div className="session-header__controls">
        {/* Model picker */}
        <div className="session-header__model-picker">
          <button className="session-header__picker-btn" onClick={() => setModelOpen((v) => !v)}>
            {session?.currentModel ?? "model"} ▾
          </button>
          {modelOpen && (
            <div className="session-header__dropdown" ref={dropdownRef}>
              <div className="session-header__dropdown-search">
                <input
                  ref={searchInputRef}
                  className="session-header__dropdown-search-input"
                  placeholder="Search models…"
                  value={modelSearch}
                  onChange={(e) => setModelSearch(e.target.value)}
                  onKeyDown={(e) => {
                    switch (e.key) {
                      case "Escape":
                        if (modelSearch) {
                          setModelSearch("");
                        } else {
                          setModelOpen(false);
                        }
                        e.preventDefault();
                        break;
                      case "ArrowDown":
                        e.preventDefault();
                        setHighlightedIndex((i) => (i < filteredModels.length - 1 ? i + 1 : 0));
                        break;
                      case "ArrowUp":
                        e.preventDefault();
                        setHighlightedIndex((i) => (i > 0 ? i - 1 : filteredModels.length - 1));
                        break;
                      case "Home":
                        e.preventDefault();
                        setHighlightedIndex(0);
                        break;
                      case "End":
                        e.preventDefault();
                        setHighlightedIndex(filteredModels.length - 1);
                        break;
                      case "Enter":
                        e.preventDefault();
                        if (filteredModels[highlightedIndex]) {
                          void handleModelChange(filteredModels[highlightedIndex]);
                        }
                        break;
                    }
                  }}
                  role="combobox"
                  aria-expanded={modelOpen}
                  aria-controls="model-listbox"
                  aria-activedescendant={
                    filteredModels.length > 0
                      ? `model-option-${filteredModels[highlightedIndex]?.id}`
                      : undefined
                  }
                  aria-autocomplete="list"
                />
              </div>
              {filteredModels.length === 0 ? (
                <div className="session-header__dropdown-empty">No models found</div>
              ) : (
                <div ref={listRef} role="listbox" id="model-listbox">
                  {filteredModels.map((m, idx) => {
                    const label = m.name ?? m.id;
                    const q = modelSearch;
                    const active = idx === highlightedIndex;
                    const selected = session?.currentModel === m.id;
                    return (
                      <button
                        key={m.id}
                        ref={(el) => {
                          if (el) itemRefs.current.set(idx, el);
                          else itemRefs.current.delete(idx);
                        }}
                        id={`model-option-${m.id}`}
                        role="option"
                        aria-selected={selected}
                        className={`session-header__dropdown-item${active ? " session-header__dropdown-item--highlighted" : ""}${selected ? " session-header__dropdown-item--active" : ""}`}
                        onClick={() => void handleModelChange(m)}
                        onMouseEnter={() => setHighlightedIndex(idx)}
                      >
                        {q ? highlightMatch(label, q) : label}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Thinking level — custom dropdown so its popup uses the
            Catppuccin surface like the model selector, and its line-height
            can accommodate descenders ('g' in "high") without clipping. */}
        <div className="session-header__thinking">
          <button
            className="session-header__picker-btn"
            onClick={() => setThinkingOpen((v) => !v)}
            disabled={thinkingDisabled}
            title={
              currentModelInfo?.reasoning === false
                ? "Current model does not support reasoning."
                : undefined
            }
          >
            {session?.thinkingLevel ?? "off"} ▾
          </button>
          {thinkingOpen && !thinkingDisabled && (
            <div className="session-header__dropdown" ref={thinkingDropdownRef}>
              {thinkingOptions.map((l) => {
                const selected = session?.thinkingLevel === l;
                return (
                  <button
                    key={l}
                    role="option"
                    aria-selected={selected}
                    className={`session-header__dropdown-item${selected ? " session-header__dropdown-item--active" : ""}`}
                    onClick={() => {
                      void handleThinkingLevel(l);
                      setThinkingOpen(false);
                    }}
                  >
                    {l}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Context meter */}
        {contextPct !== null && (
          <div className="session-header__context">
            <div className="context-meter" title={`${contextPct}% context used`}>
              <div className="context-meter__fill" style={{ width: `${contextPct}%` }} />
            </div>
            <span className="session-header__meta">
              {stats?.tokens?.total != null && formatTokens(stats.tokens.total)}
              {stats?.cost != null && ` · ${formatCost(stats.cost)}`}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
