import type { SessionId } from "@shared/ids.js";
import type { ModelInfo, SessionStats } from "@shared/pi-protocol/responses.js";
import { SessionStatsSchema } from "@shared/pi-protocol/responses.js";
import { THINKING_LEVELS, type ThinkingLevel } from "@shared/pi-protocol/thinking.js";
import type React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useEscapeClaim } from "../../hooks/useEscapeClaim.js";
import { useVirtualList } from "../../hooks/useVirtualList.js";
import { findCurrentModel, modelDisplayName, modelKey } from "../../lib/model-utils.js";
import { openDiffForSession, useDiffStore } from "../../stores/diff-store.js";
import { gitRootForSession, useSessionsStore } from "../../stores/sessions-store.js";
import { FadeText } from "../common/FadeText.js";
import { IconBranch, IconCheck, IconChevronDown } from "../common/icons.js";
import { UnifiedViewToggle } from "../ext-ui/UnifiedViewToggle.js";
import { NotificationBellButton } from "../notifications/NotificationStack.js";
import { ContextMeter } from "./ContextMeter.js";
import "./SessionHeader.css";

interface SessionHeaderProps {
  sessionId: SessionId;
}

export function SessionHeader({ sessionId }: SessionHeaderProps): React.ReactElement {
  const session = useSessionsStore((s) => s.sessions.get(sessionId));
  const setStats = useSessionsStore((s) => s.setStats);
  const setSessionName = useSessionsStore((s) => s.setSessionName);
  const setSessionFile = useSessionsStore((s) => s.setSessionFile);
  const refreshWorkspaceSessions = useSessionsStore((s) => s.refreshWorkspaceSessions);
  const bootstrapModelState = useSessionsStore((s) => s.bootstrapModelState);

  const [editingName, setEditingName] = useState(false);
  const [nameInput, setNameInput] = useState("");
  const nameInputRef = useRef<HTMLInputElement>(null);

  // Claim ESC while the rename field is open so a background streaming
  // session isn't aborted.
  useEscapeClaim(editingName);

  // Cold-aware gate. A boolean on purpose: starting→ready doesn't re-fire
  // effects, but cold→starting does. Sessions whose process is alive get
  // to drive their models/stats/get_state effects.
  const live = session?.status === "starting" || session?.status === "ready";

  // Seed the store with pi's authoritative model + thinking level for this
  // session, and (for brand-new sessions) apply the global last-used
  // preference — ONCE per session.
  //
  // This effect re-runs on every header mount, which includes every tab
  // switch back to this session (only the active session's SessionHeader is
  // mounted; see TitleBar). The actual work is idempotent and guarded inside
  // `bootstrapModelState` by the session's `modelInitialized` flag, so a
  // remount is a no-op. That guard — living in the store, not in this
  // component — is what structurally enforces invariant #2: switching to
  // another session, changing its model, and switching back can NEVER
  // re-apply that now-global preference and silently change this session's
  // model. The dropdown reads `session.currentModel` / `session.thinkingLevel`
  // straight from the store (invariant #1), and those only change via this
  // one-time bootstrap, pi events for this session, or the user's explicit
  // dropdown / slash-command actions in this session.
  useEffect(() => {
    if (!live) return;
    void bootstrapModelState(sessionId);
  }, [sessionId, live, bootstrapModelState]);

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
        // Reflow the secondary controls into the SessionSubBar once the header
        // can't hold the name + the full controls cluster. The cluster maxes
        // out around ~540px (capped model id + longest thinking label + token
        // stats); 560 keeps a margin so nothing clips at the boundary. The
        // header's own `min-width: 0` (SessionHeader.css) is what makes this
        // measure the *available* width rather than the content-overflow width.
        const w = entry.contentRect.width;
        setHeaderCompact(w < 560);
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [setHeaderCompact]);

  return (
    <div className="session-header" ref={headerRef}>
      {/* Primary row: name on the left; worktree + controls on the right. */}
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
            <button
              type="button"
              className="session-header__name-btn fade-scope"
              onClick={handleRenameStart}
              title={
                session?.piVersion
                  ? `${session?.sessionName ?? session?.sessionTitle ?? "Untitled session"} · pi ${session.piVersion}`
                  : (session?.sessionName ?? session?.sessionTitle ?? "Untitled session")
              }
            >
              <FadeText>
                {session?.sessionName ?? session?.sessionTitle ?? "Untitled session"}
              </FadeText>
            </button>
          )}
        </div>

        {session?.worktreeName && (
          <WorktreeChip
            sessionId={sessionId}
            name={session.worktreeName}
            branch={session.worktreeBranch ?? session.worktreeName ?? ""}
            base={session.worktreeFromBase}
            path={session.worktreePath}
          />
        )}
        {!compact && <SessionControls sessionId={sessionId} />}
        <NotificationBellButton sessionId={sessionId} />
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
  const applyModelChange = useSessionsStore((s) => s.applyModelChange);
  const applyThinkingLevel = useSessionsStore((s) => s.applyThinkingLevel);
  const addToast = useSessionsStore((s) => s.addToast);

  // ── Model picker state ────────────────────────────────────────────
  const [modelOpen, setModelOpen] = useState(false);
  const [modelSearch, setModelSearch] = useState("");
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const modelHighlightSourceRef = useRef<"keyboard" | "pointer" | "programmatic">("programmatic");
  const searchInputRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const filteredModels = useMemo(() => {
    const q = modelSearch.toLowerCase();
    return (session?.availableModels ?? []).filter((m) => {
      if (!q) return true;
      const label = m.name ?? m.id;
      return (
        label.toLowerCase().includes(q) ||
        m.id.toLowerCase().includes(q) ||
        (m.provider ?? "").toLowerCase().includes(q)
      );
    });
  }, [session?.availableModels, modelSearch]);

  useEffect(() => {
    if (!modelOpen) {
      setModelSearch("");
      modelHighlightSourceRef.current = "programmatic";
      setHighlightedIndex(0);
      return;
    }
    setModelSearch("");
    modelHighlightSourceRef.current = "programmatic";
    setHighlightedIndex(0);
    setTimeout(() => searchInputRef.current?.focus(), 10);
  }, [modelOpen]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: depends on search value
  useEffect(() => {
    modelHighlightSourceRef.current = "programmatic";
    setHighlightedIndex(0);
  }, [modelSearch]);

  const modelVirtualList = useVirtualList<HTMLDivElement>({
    count: filteredModels.length,
    rowHeight: 34,
    minOverscan: 32,
    overscanScreens: 2,
  });

  useEffect(() => {
    modelHighlightSourceRef.current = "programmatic";
    setHighlightedIndex((i) =>
      filteredModels.length === 0 ? 0 : Math.min(i, filteredModels.length - 1),
    );
  }, [filteredModels.length]);

  useEffect(() => {
    if (!modelOpen) return;
    // Hover should update only the visual highlight; keyboard/programmatic
    // navigation is the only path that should scroll the dropdown.
    if (modelHighlightSourceRef.current === "pointer") return;
    modelVirtualList.ensureIndexVisible(highlightedIndex);
  }, [highlightedIndex, modelOpen, modelVirtualList.ensureIndexVisible]);

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
      const res = await applyModelChange(sessionId, model);
      if (!res.ok) {
        addToast(sessionId, `Failed to set model: ${res.error}`, "error");
      }
    },
    [sessionId, addToast, applyModelChange],
  );

  // ── Thinking level picker state ───────────────────────────────────
  const [thinkingOpen, setThinkingOpen] = useState(false);
  const thinkingDropdownRef = useRef<HTMLDivElement>(null);

  // Claim ESC while either the model or thinking dropdown is open so a
  // background streaming session isn't aborted (each dropdown's own
  // outside-click / Escape handling closes it).
  useEscapeClaim(modelOpen || thinkingOpen);

  const currentModelInfo = useMemo<ModelInfo | undefined>(
    () =>
      findCurrentModel(
        session?.availableModels ?? [],
        session?.currentModel,
        session?.currentProvider,
      ),
    [session?.availableModels, session?.currentModel, session?.currentProvider],
  );
  // Button label: the active model's name with its provider in brackets
  // (mirrors pi's TUI "glm-5.2 [zai]"), so when the same model id is offered
  // by several providers the user can see which subscription/API is in use.
  const modelButtonLabel = currentModelInfo
    ? modelDisplayName(currentModelInfo)
    : session?.currentModel
      ? `${session.currentModel}${session.currentProvider ? ` [${session.currentProvider}]` : ""}`
      : "model";
  const thinkingOptions: readonly ThinkingLevel[] = useMemo(() => {
    if (currentModelInfo?.reasoning === false) {
      return ["off"];
    }
    return THINKING_LEVELS;
  }, [currentModelInfo]);
  const thinkingDisabled = thinkingOptions.length <= 1;

  const handleThinkingLevel = useCallback(
    async (level: ThinkingLevel) => {
      setThinkingOpen(false);
      const res = await applyThinkingLevel(sessionId, level);
      if (!res.ok) {
        addToast(sessionId, `Failed to set thinking level: ${res.error}`, "error");
      } else if (res.clampedTo) {
        addToast(
          sessionId,
          `Model does not support thinking level: ${level} — using ${res.clampedTo} instead.`,
          "warning",
        );
      }
    },
    [sessionId, applyThinkingLevel, addToast],
  );

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

  return (
    <div className="session-header__controls">
      {/* Unified-TUI view toggle — shown only while a factory `setWidget` panel is live.
          Placed in the right-side controls cluster after the worktree chip (when present)
          and before the changes button. Uses text labels "Extension" and "Input" for clarity. */}
      {session?.unifiedPanel && (
        <UnifiedViewToggle sessionId={sessionId} extensionLabel="Extension" inputLabel="Input" />
      )}
      <ChangesButton sessionId={sessionId} />
      {/* Model picker */}
      <div className="session-header__model-picker">
        <button
          type="button"
          className="session-header__picker-btn session-header__model-btn fade-scope"
          onClick={() => setModelOpen((v) => !v)}
          title={modelButtonLabel}
        >
          <FadeText className="session-header__picker-label">{modelButtonLabel}</FadeText>
          <IconChevronDown className="session-header__caret" />
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
                      modelHighlightSourceRef.current = "keyboard";
                      setHighlightedIndex((i) => (i < filteredModels.length - 1 ? i + 1 : 0));
                      break;
                    case "ArrowUp":
                      e.preventDefault();
                      modelHighlightSourceRef.current = "keyboard";
                      setHighlightedIndex((i) => (i > 0 ? i - 1 : filteredModels.length - 1));
                      break;
                    case "Home":
                      e.preventDefault();
                      modelHighlightSourceRef.current = "keyboard";
                      setHighlightedIndex(0);
                      break;
                    case "End":
                      e.preventDefault();
                      modelHighlightSourceRef.current = "keyboard";
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
                  filteredModels.length > 0 ? `model-option-${highlightedIndex}` : undefined
                }
                aria-autocomplete="list"
              />
            </div>
            {filteredModels.length === 0 ? (
              <div className="session-header__dropdown-empty">No models found</div>
            ) : (
              <div
                ref={modelVirtualList.containerRef}
                onScroll={modelVirtualList.onScroll}
                role="listbox"
                id="model-listbox"
                className="session-header__dropdown-list session-header__dropdown-list--virtual"
              >
                <div
                  className="session-header__virtual-spacer"
                  style={{ height: modelVirtualList.totalHeight }}
                >
                  <div
                    className="session-header__virtual-window"
                    style={{ transform: `translateY(${modelVirtualList.offsetY}px)` }}
                  >
                    {modelVirtualList.rows.map(({ index: idx }) => {
                      const m = filteredModels[idx];
                      if (!m) return null;
                      const label = modelDisplayName(m);
                      const q = modelSearch;
                      const active = idx === highlightedIndex;
                      // Compare against the single resolved current entry by key
                      // (not per-item id matching) so that when the provider is
                      // unknown and duplicate same-id entries exist, at most ONE
                      // row highlights instead of every same-id copy getting a ✓.
                      const selected =
                        currentModelInfo != null && modelKey(m) === modelKey(currentModelInfo);
                      return (
                        <button
                          type="button"
                          key={modelKey(m)}
                          id={`model-option-${idx}`}
                          role="option"
                          aria-selected={selected}
                          className={`session-header__dropdown-item fade-scope${active ? " session-header__dropdown-item--highlighted" : ""}${selected ? " session-header__dropdown-item--active" : ""}`}
                          onClick={() => void handleModelChange(m)}
                          onMouseEnter={() => {
                            modelHighlightSourceRef.current = "pointer";
                            setHighlightedIndex(idx);
                          }}
                        >
                          <span className="session-header__dropdown-item-check" aria-hidden>
                            {selected ? <IconCheck /> : null}
                          </span>
                          <span className="session-header__dropdown-item-label" title={label}>
                            {q ? highlightMatch(label, q) : label}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
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
          <span>{session?.thinkingLevel ?? "off"}</span>
          <IconChevronDown className="session-header__caret" />
        </button>
        {thinkingOpen && !thinkingDisabled && (
          <div className="session-header__dropdown" ref={thinkingDropdownRef}>
            <div className="session-header__dropdown-list">
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
          </div>
        )}
      </div>

      {/* Context ring — click for a usage breakdown dropdown. */}
      <ContextMeter sessionId={sessionId} />
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
  // For an attached worktree there is no "cut from" relationship — the
  // attach IPC stores `base = branch` as a sentinel meaning "attached,
  // not cut from anything". Skip the `· from <base>` segment in that
  // case so the tooltip stays honest about the worktree's provenance.
  const showFromBase = base && base !== branch;
  const detail = `${branch}${showFromBase ? ` · from ${base}` : ""}${path ? ` · ${path}` : ""}`;
  // A real <button> so it's keyboard-operable (Enter/Space) and screen-reader
  // friendly without hand-rolling key handlers.
  return (
    <button
      type="button"
      className="session-header__worktree-chip fade-scope"
      title={path ? `${detail} · click to copy path` : detail}
      data-testid="worktree-chip"
      onClick={() => {
        if (!path) return;
        void window.pivis
          .invoke("clipboard.writeText", { text: path })
          .then(() => addToast(sessionId, "Worktree path copied", "info"))
          .catch(() => addToast(sessionId, "Failed to copy worktree path", "error"));
      }}
    >
      <IconBranch />
      <FadeText className="session-header__worktree-label">{name}</FadeText>
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
