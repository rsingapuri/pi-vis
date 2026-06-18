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
import { openDiffForSession, useDiffStore } from "../../stores/diff-store.js";
import { gitRootForSession, useSessionsStore } from "../../stores/sessions-store.js";
import { useSettingsStore } from "../../stores/settings-store.js";
import "./SessionHeader.css";

interface SessionHeaderProps {
  sessionId: SessionId;
}

export function SessionHeader({ sessionId }: SessionHeaderProps): React.ReactElement {
  const session = useSessionsStore((s) => s.sessions.get(sessionId));
  const setAvailableModels = useSessionsStore((s) => s.setAvailableModels);
  const setCurrentModel = useSessionsStore((s) => s.setCurrentModel);
  const setStats = useSessionsStore((s) => s.setStats);
  const setSessionName = useSessionsStore((s) => s.setSessionName);
  const setSessionFile = useSessionsStore((s) => s.setSessionFile);
  const refreshWorkspaceSessions = useSessionsStore((s) => s.refreshWorkspaceSessions);
  const setThinkingLevel = useSessionsStore((s) => s.setThinkingLevel);
  const { settings } = useSettingsStore();

  const [editingName, setEditingName] = useState(false);
  const [nameInput, setNameInput] = useState("");
  const nameInputRef = useRef<HTMLInputElement>(null);

  const modelAppliedRef = useRef(false);

  // Cold-aware gate. A boolean on purpose: starting→ready doesn't re-fire
  // effects, but cold→starting does. Sessions whose process is alive get
  // to drive their models/stats/get_state effects.
  const live = session?.status === "starting" || session?.status === "ready";

  // Load models and apply last-used model preference
  useEffect(() => {
    if (!live) return;
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
  }, [sessionId, live, settings.lastUsedModel, setAvailableModels, setCurrentModel]);

  // Authoritative state on mount / session switch: seed the store with pi's
  // current model and thinking level. This makes the dropdown match pi even
  // before any user interaction or `thinking_level_changed` event arrives.
  useEffect(() => {
    if (!live) return;
    let cancelled = false;
    void window.pivis
      .invoke("session.sendCommand", { sessionId, command: { type: "get_state" } })
      .then((res) => {
        if (cancelled) return;
        const raw = res?.data as
          | {
              thinkingLevel?: unknown;
              model?: { id?: unknown };
              sessionName?: unknown;
              sessionFile?: unknown;
            }
          | undefined;
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
        if (typeof raw.sessionFile === "string" && raw.sessionFile) {
          setSessionFile(sessionId, raw.sessionFile);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [sessionId, live, setThinkingLevel, setCurrentModel, setSessionName, setSessionFile]);

  // Poll stats after each agent_end and periodically while streaming
  useEffect(() => {
    if (!live) return;
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
              const stats = parsed.data as SessionStats;
              setStats(sessionId, stats);
              if (stats.sessionFile) setSessionFile(sessionId, stats.sessionFile);
            }
          }
        })
        .catch(() => {});
    };

    fetchStats();
    const interval = setInterval(fetchStats, 60_000);
    return () => clearInterval(interval);
  }, [sessionId, live, setStats, setSessionFile]);

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

  // The model + thinking pickers (and their handlers) live in
  // <SessionControls> — this component only owns the name, the worktree chip,
  // the data-loading effects, and the compact-mode reflow.

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

  // ── Compact mode (responsive reflow) ───────────────────────────────
  const headerRef = useRef<HTMLDivElement>(null);
  const setHeaderCompact = useSessionsStore((s) => s.setHeaderCompact);
  const compact = useSessionsStore((s) => s.headerCompact);

  useEffect(() => {
    const el = headerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const w = entry.contentRect.width;
        setHeaderCompact(w < 500);
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [setHeaderCompact]);

  const stats = session?.stats;
  const contextPct =
    stats?.contextUsage?.percent != null ? Math.round(stats.contextUsage.percent) : null;

  return (
    <div className="session-header" ref={headerRef}>
      {/* Primary row: name + WorktreeChip (always visible) */}
      <div className="session-header__primary">
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
            <button type="button" className="session-header__name-btn" onClick={handleRenameStart}>
              {session?.sessionName ?? session?.sessionTitle ?? "Untitled session"}
            </button>
          )}
          {session?.worktreeName && (
            <WorktreeChip
              sessionId={sessionId}
              name={session.worktreeName}
              branch={session.worktreeBranch ?? session.worktreeName ?? ""}
              base={session.worktreeFromBase}
              path={session.worktreePath}
            />
          )}
        </div>

        {!compact && <SessionControls sessionId={sessionId} />}
      </div>
    </div>
  );
}

/**
 * The secondary controls cluster — rendered in the title bar (wide) or
 * in SessionSubBar (compact). Extracted so the same JSX renders in
 * either position.
 */
export function SessionControls({
  sessionId,
}: {
  sessionId: SessionId;
}): React.ReactElement {
  const session = useSessionsStore((s) => s.sessions.get(sessionId));
  const setCurrentModel = useSessionsStore((s) => s.setCurrentModel);
  const setThinkingLevel = useSessionsStore((s) => s.setThinkingLevel);
  const addToast = useSessionsStore((s) => s.addToast);

  // ── Model picker state ────────────────────────────────────────────
  const [modelOpen, setModelOpen] = useState(false);
  const [modelSearch, setModelSearch] = useState("");
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Map<number, HTMLButtonElement>>(new Map());

  const filteredModels = useMemo(() => {
    const q = modelSearch.toLowerCase();
    return (session?.availableModels ?? []).filter((m) => {
      if (!q) return true;
      return (m.name ?? m.id).toLowerCase().includes(q);
    });
  }, [session?.availableModels, modelSearch]);

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

  // biome-ignore lint/correctness/useExhaustiveDependencies: depends on search value
  useEffect(() => {
    setHighlightedIndex(0);
  }, [modelSearch]);

  useEffect(() => {
    if (!modelOpen) return;
    const btn = itemRefs.current.get(highlightedIndex);
    btn?.scrollIntoView({ block: "nearest" });
  }, [highlightedIndex, modelOpen]);

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

  const handleModelChange = useCallback(
    async (model: ModelInfo) => {
      setModelOpen(false);
      setCurrentModel(sessionId, model.id);
      try {
        await window.pivis.invoke("session.sendCommand", {
          sessionId,
          command: {
            type: "set_model",
            provider: model.provider ?? model.id.split("/")[0] ?? "",
            modelId: model.id,
          },
        });
      } catch (err) {
        console.error("Failed to set model:", err);
        addToast(sessionId, `Failed to set model: ${String(err)}`, "error");
      }
    },
    [sessionId, addToast, setCurrentModel],
  );

  // ── Thinking level picker state ───────────────────────────────────
  const [thinkingOpen, setThinkingOpen] = useState(false);
  const thinkingDropdownRef = useRef<HTMLDivElement>(null);

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

  const lastRequestedThinkingLevelRef = useRef<ThinkingLevel | null>(null);

  const handleThinkingLevel = useCallback(
    async (level: ThinkingLevel) => {
      setThinkingOpen(false);
      lastRequestedThinkingLevelRef.current = level;
      const validated = ThinkingLevelSchema.parse(level);
      setThinkingLevel(sessionId, validated);
      try {
        await window.pivis.invoke("session.sendCommand", {
          sessionId,
          command: { type: "set_thinking_level", level: validated },
        });
        const res = await window.pivis.invoke("session.sendCommand", {
          sessionId,
          command: { type: "get_state" },
        });
        const raw = res?.data as { thinkingLevel?: unknown } | undefined;
        if (raw && typeof raw.thinkingLevel === "string") {
          const confirmed = ThinkingLevelSchema.safeParse(raw.thinkingLevel);
          if (confirmed.success) {
            setThinkingLevel(sessionId, confirmed.data);
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

  useEffect(() => {
    if (session?.thinkingLevel == null) return;
    if (lastRequestedThinkingLevelRef.current != null) {
      lastRequestedThinkingLevelRef.current = null;
    }
  }, [session?.thinkingLevel]);

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

  const highlightMatch = useCallback((text: string, query: string): React.ReactNode => {
    const idx = text.toLowerCase().indexOf(query.toLowerCase());
    if (idx === -1) return text;
    return (
      <>
        {text.slice(0, idx)}
        <mark className="session-header__match">{text.slice(idx, idx + query.length)}</mark>
        {text.slice(idx + query.length)}
      </>
    );
  }, []);

  const stats = session?.stats;
  const contextPct =
    stats?.contextUsage?.percent != null ? Math.round(stats.contextUsage.percent) : null;

  return (
    <div className="session-header__controls">
      <ChangesButton sessionId={sessionId} />
      {/* Model picker */}
      <div className="session-header__model-picker">
        <button
          type="button"
          className="session-header__picker-btn"
          onClick={() => setModelOpen((v) => !v)}
        >
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
                      type="button"
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
          type="button"
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
                  type="button"
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

      {/* Context meter — always rendered while a session is active. */}
      <div className="session-header__context">
        <div
          className="context-meter"
          title={contextPct !== null ? `${contextPct}% context used` : "Context usage"}
        >
          <div
            className={`context-meter__fill${(contextPct ?? 0) >= 90 ? " context-meter__fill--danger" : (contextPct ?? 0) >= 80 ? " context-meter__fill--warn" : ""}`}
            style={{ width: `${contextPct ?? 0}%` }}
          />
        </div>
        <span className="session-header__meta">
          {stats?.tokens?.total != null && formatTokens(stats.tokens.total)}
          {stats?.cost != null && ` · ${formatCost(stats.cost)}`}
        </span>
      </div>
    </div>
  );
}

/**
 * Worktree chip — shown next to the session name when the session is
 * running in a git worktree.
 */
function WorktreeChip({
  sessionId,
  name,
  branch,
  base,
  path,
}: {
  sessionId: SessionId;
  name: string;
  branch: string;
  base?: string | undefined;
  path?: string | undefined;
}): React.ReactElement {
  const addToast = useSessionsStore((s) => s.addToast);
  const detail = `${branch}${base ? ` · from ${base}` : ""}${path ? ` · ${path}` : ""}`;
  // A real <button> so it's keyboard-operable (Enter/Space) and screen-reader
  // friendly without hand-rolling key handlers.
  return (
    <button
      type="button"
      className="session-header__worktree-chip"
      title={path ? `${detail} · click to copy path` : detail}
      onClick={() => {
        if (!path) return;
        void navigator.clipboard.writeText(path);
        addToast(sessionId, "Worktree path copied", "info");
      }}
    >
      ⑂ {name}
    </button>
  );
}

// ── Changes button (WP5a) ──────────────────────────────────────────
//
// Mirrors the existing agent_end → stats refresh pattern. Renders a
// ghost button matching the model/thinking picker style with a live
// badge showing the changed-file count, or just `±` dimmed when the
// working tree is clean.
function ChangesButton({ sessionId }: { sessionId: SessionId }): React.ReactElement | null {
  const live = useSessionsStore((s) => {
    const st = s.sessions.get(sessionId)?.status;
    return st === "ready" || st === "starting";
  });
  // The git root (worktree path when present, else workspace path). Derived
  // via a selector so the effect can depend on the primitive root directly
  // rather than the whole session object.
  const root = useSessionsStore((s) => {
    const sess = s.sessions.get(sessionId);
    return sess ? gitRootForSession(sess) : undefined;
  });
  const badge = useDiffStore((s) => s.badge);
  const badgeKind = useDiffStore((s) => s.badgeKind);
  const refreshBadge = useDiffStore((s) => s.refreshBadge);

  // Refresh on session live, agent_end, every tool call, and window
  // focus. Refreshing after each tool_execution_end keeps the changed-file
  // count live as the agent edits files; refreshBadge is debounced so a
  // burst of tool calls collapses into one git invocation. Mirrors the
  // existing stats effect in this file.
  useEffect(() => {
    if (!live || !root) return;
    void refreshBadge(root);

    const unsubEvent = window.pivis.on("session.event", ({ sessionId: sid, event }) => {
      if (sid !== sessionId) return;
      if (event.type === "agent_end" || event.type === "tool_execution_end") {
        void refreshBadge(root);
      }
    });
    const onFocus = (): void => {
      void refreshBadge(root);
    };
    window.addEventListener("focus", onFocus);
    return () => {
      unsubEvent();
      window.removeEventListener("focus", onFocus);
    };
  }, [live, root, sessionId, refreshBadge]);

  // Don't render when the workspace is not a repo (badge resolved
  // "not-a-repo" or "git-missing") or when the badge is still loading.
  if (badgeKind === "not-a-repo" || badgeKind === "git-missing") return null;
  if (badge === null) return null;

  const hasChanges = badge.fileCount > 0;
  return (
    <button
      type="button"
      className={`session-header__picker-btn session-header__changes-btn${hasChanges ? "" : " session-header__changes-btn--clean"}`}
      onClick={() => openDiffForSession(sessionId)}
      title="View changes (⌘G)"
      aria-label="View changes"
      data-testid="changes-button"
    >
      <span aria-hidden>±</span>
      {hasChanges && <span className="session-header__changes-count">{badge.fileCount}</span>}
    </button>
  );
}
