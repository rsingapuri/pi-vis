import type { SessionId } from "@shared/ids.js";
import type { SessionSummary } from "@shared/ipc-contract.js";
import type { LoginProvider, ModelInfo } from "@shared/pi-protocol/responses.js";
import type React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useEscapeClaim } from "../../hooks/useEscapeClaim.js";
import { useVirtualList } from "../../hooks/useVirtualList.js";
import type { PickerRequest } from "../../lib/commands/execute.js";
import { findCurrentModel, modelDisplayName, modelKey } from "../../lib/model-utils.js";
import { dispatchSessionIntent } from "../../lib/session-intent.js";
import {
  authoritySnapshotFor,
  sessionMatchesRuntime,
  useSessionsStore,
} from "../../stores/sessions-store.js";
import { FadeText } from "../common/FadeText.js";
import { ScrollFadeFrame } from "../common/ScrollFadeFrame.js";
import "./AppPickerHost.css";

interface PickerHostProps {
  sessionId: SessionId;
}

/**
 * AppPickerHost — built-in pickers for /model, /fork, /resume.
 *
 * Why a separate host from ExtensionDialogHost?
 *   - Extension dialogs come from the wire and use the request/response
 *     RPC protocol. Built-in pickers are local UI: the executor decides
 *     which picker to open (via store.openPicker) and the host renders it.
 *   - Extension dialogs queue; built-in pickers are single-slot (a
 *     subsequent /model replaces an open model picker).
 *   - Extension dialogs can have a server-side timeout; built-in pickers
 *     have no timeout — the user is the one driving the choice.
 *
 * The picker replaces the Composer in the flex slot (same in-place
 * treatment as ExtensionDialogHost and CustomPanelHost) rather than
 * opening as a modal scrim. The slot is invisible chrome (transparent,
 * no top border, matching the Composer's outer treatment) and the inner
 * `.picker` card mirrors the Composer's surface0 / border / radius —
 * so the layout doesn't shift when a picker opens. The transcript
 * above stays scrollable, the session header stays clickable, and the
 * diff viewer (Cmd+G) still works while a picker is open.
 *
 * The host is mounted in place of the Composer by App.tsx when a
 * picker is pending, so the Composer and the picker are never both
 * visible.
 *
 * The model picker mirrors SessionHeader's dropdown behaviour: same
 * search/highlight/keyboard pattern, but standalone (we deliberately do
 * not programmatically open the header dropdown — its anchor sits on the
 * header bar and wouldn't be in the right place when /model is invoked
 * from the composer).
 */
export function AppPickerHost({ sessionId }: PickerHostProps): React.ReactElement | null {
  const picker = useSessionsStore((s) => s.sessions.get(sessionId)?.pendingPicker);
  const closePicker = useSessionsStore((s) => s.closePicker);
  const addToast = useSessionsStore((s) => s.addToast);
  const openSessionTab = useSessionsStore((s) => s.openSessionTab);
  const setActiveSession = useSessionsStore((s) => s.setActiveSession);
  const requestComposerFocus = useSessionsStore((s) => s.requestComposerFocus);

  // Claim ESC while any picker is open so a background streaming session
  // isn't aborted (the picker's own ESC handler closes it).
  useEscapeClaim(!!picker);

  if (!picker) return null;
  const pickerRuntime =
    picker.expectedHostInstanceId && picker.expectedSessionEpoch !== undefined
      ? {
          hostInstanceId: picker.expectedHostInstanceId,
          sessionEpoch: picker.expectedSessionEpoch,
        }
      : undefined;
  const pickerCursor = (() => {
    const semantic = useSessionsStore.getState().sessions.get(sessionId)
      ?.authorityProjection?.semantic;
    return semantic?.state === "following" &&
      semantic.cursor.hostInstanceId === pickerRuntime?.hostInstanceId &&
      semantic.cursor.sessionEpoch === pickerRuntime.sessionEpoch
      ? semantic.cursor
      : undefined;
  })();
  const requirePickerObservation = () => {
    if (!pickerRuntime) throw new Error("Picker has no originating runtime identity");
    return { owner: pickerRuntime, ...(pickerCursor ? { cursor: pickerCursor } : {}) };
  };
  const pickerSlotIsCurrent = () =>
    useSessionsStore.getState().sessions.get(sessionId)?.pendingPicker === picker;
  const pickerRuntimeIsCurrent = () => {
    const current = useSessionsStore.getState().sessions.get(sessionId);
    return (
      pickerRuntime !== undefined &&
      pickerSlotIsCurrent() &&
      sessionMatchesRuntime(current, pickerRuntime)
    );
  };

  // The picker sub-components are mounted when a picker is active. They
  // each receive the same close-on-cancel pattern.
  return (
    <div className="picker-slot" role="dialog" aria-label="Picker">
      {picker.kind === "model" && (
        <ModelPicker
          sessionId={sessionId}
          {...(picker.search !== undefined ? { search: picker.search } : {})}
          onClose={() => closePicker(sessionId)}
          onPick={async (model) => {
            const observation = requirePickerObservation();
            const receipt = await dispatchSessionIntent(
              sessionId,
              { kind: "setModel", provider: model.provider ?? "", modelId: model.id },
              observation,
            );
            if (!pickerRuntimeIsCurrent()) return;
            if (receipt.status === "not_admitted" || receipt.status === "delivery_unknown") {
              addToast(sessionId, "Failed to request model change", "error");
              return;
            }
            closePicker(sessionId);
          }}
        />
      )}
      {picker.kind === "fork" && (
        <ForkPicker
          messages={picker.messages}
          onClose={() => closePicker(sessionId)}
          onPick={async (entryId) => {
            const observation = requirePickerObservation();
            const receipt = await dispatchSessionIntent(
              sessionId,
              {
                kind: "invokeCommand",
                text: `/fork ${entryId}`,
                editorRevision:
                  useSessionsStore.getState().sessions.get(sessionId)?.editorRevision ?? 0,
              },
              observation,
            );
            if (!pickerRuntimeIsCurrent()) return;
            if (receipt.status === "not_admitted" || receipt.status === "delivery_unknown") {
              addToast(sessionId, "Failed to request fork", "error");
              return;
            }
            // Authority frames own the successor, transcript, and editor.
            closePicker(sessionId);
          }}
        />
      )}
      {picker.kind === "resume" && (
        <ResumePicker
          sessions={picker.sessions}
          onClose={() => closePicker(sessionId)}
          onPick={async (target) => {
            if (!pickerRuntimeIsCurrent()) return;
            // Focus an existing tab if the file is already open, else
            // open a new tab. `openSessionTab` returns the id either way.
            const liveTab = Array.from(useSessionsStore.getState().sessions.values()).find(
              (s) => s.sessionFile === target.filePath,
            );
            if (liveTab) {
              requestComposerFocus(liveTab.sessionId);
              void setActiveSession(liveTab.sessionId);
              closePicker(sessionId);
              return;
            }
            const workspacePath = useSessionsStore
              .getState()
              .sessions.get(sessionId)?.workspacePath;
            if (!workspacePath) {
              addToast(sessionId, "No active workspace", "error");
              closePicker(sessionId);
              return;
            }
            const id = await openSessionTab(workspacePath, target.filePath, {
              focus: true,
              requestComposerFocus: true,
            });
            if (!pickerRuntimeIsCurrent()) return;
            if (id) void setActiveSession(id);
            closePicker(sessionId);
          }}
        />
      )}
      {picker.kind === "scoped-models" && (
        <ScopedModelsPicker
          models={picker.models}
          enabledIds={picker.enabledIds}
          onClose={() => closePicker(sessionId)}
          onApply={async (enabledIds, persist) => {
            const observation = requirePickerObservation();
            const command = persist ? "/models save" : "/models apply";
            const receipt = await dispatchSessionIntent(
              sessionId,
              {
                kind: "invokeCommand",
                text: enabledIds ? `${command} ${enabledIds.join(",")}` : command,
                editorRevision:
                  useSessionsStore.getState().sessions.get(sessionId)?.editorRevision ?? 0,
              },
              observation,
            );
            if (!pickerRuntimeIsCurrent()) return;
            if (receipt.status === "not_admitted" || receipt.status === "delivery_unknown") {
              addToast(sessionId, "Failed to request model scope update", "error");
              return;
            }
            closePicker(sessionId);
          }}
        />
      )}
      {picker.kind === "login" && (
        <LoginPicker
          providers={picker.providers}
          onClose={() => closePicker(sessionId)}
          onPick={async (provider, authType) => {
            const observation = requirePickerObservation();
            const receipt = await dispatchSessionIntent(
              sessionId,
              { kind: "loginProvider", providerId: provider.id, authType },
              observation,
            );
            if (!pickerRuntimeIsCurrent()) return;
            if (receipt.status === "not_admitted" || receipt.status === "delivery_unknown") {
              addToast(sessionId, "Couldn't start sign-in", "error");
              return;
            }
            closePicker(sessionId);
          }}
        />
      )}
      {picker.kind === "logout" && (
        <LogoutPicker
          providers={picker.providers}
          onClose={() => closePicker(sessionId)}
          onPick={async (provider) => {
            const observation = requirePickerObservation();
            const receipt = await dispatchSessionIntent(
              sessionId,
              {
                kind: "invokeCommand",
                text: `/logout ${provider.id}`,
                editorRevision:
                  useSessionsStore.getState().sessions.get(sessionId)?.editorRevision ?? 0,
              },
              observation,
            );
            if (!pickerRuntimeIsCurrent()) return;
            if (receipt.status === "not_admitted" || receipt.status === "delivery_unknown") {
              addToast(sessionId, "Failed to request logout", "error");
              return;
            }
            closePicker(sessionId);
          }}
        />
      )}
      {picker.kind === "trust" && (
        <TrustPicker
          sessionId={sessionId}
          runtime={requirePickerObservation().owner}
          cwd={picker.cwd}
          savedDecision={picker.savedDecision}
          projectTrusted={picker.projectTrusted}
          options={picker.options}
          onClose={() => {
            if (pickerSlotIsCurrent()) closePicker(sessionId);
          }}
        />
      )}
    </div>
  );
}

// ── Helper: re-seed transcript when fork changes the file ────────────────

// AdoptHelper removed: the fork command triggers fileChanged in main,
// which already calls adoptSessionFile + loadHistory + refreshWorkspaceSessions
// via the App-level subscription.

// ── /model picker ────────────────────────────────────────────────────────

function ModelPicker({
  sessionId,
  search,
  onClose,
  onPick,
}: {
  sessionId: SessionId;
  search?: string;
  onClose: () => void;
  onPick: (model: ModelInfo) => void;
}): React.ReactElement {
  const session = useSessionsStore((s) => s.sessions.get(sessionId));
  const refreshModelsSilently = useSessionsStore((s) => s.refreshModelsSilently);
  const semanticSnapshot = authoritySnapshotFor(session);
  const modelOwner =
    session?.authorityProjection?.semantic.state === "following"
      ? session.authorityProjection.semantic.cursor
      : undefined;
  const availableModels = semanticSnapshot ? (session?.availableModels ?? []) : [];
  const currentModel = semanticSnapshot?.model?.id;
  const currentProvider = semanticSnapshot?.model?.provider;
  const refreshFailed = Boolean(
    session?.modelRefreshFailure &&
      modelOwner &&
      session.modelRefreshFailure.hostInstanceId === modelOwner.hostInstanceId &&
      session.modelRefreshFailure.sessionEpoch === modelOwner.sessionEpoch,
  );
  // Resolve the single active entry once and compare items by key — so that
  // when the provider is unknown and duplicate same-id entries exist, at most
  // ONE row is marked selected (not every same-id copy).
  const currentModelInfo = findCurrentModel(availableModels, currentModel, currentProvider);
  const selectedKey = currentModelInfo ? modelKey(currentModelInfo) : null;
  const [query, setQuery] = useState(search ?? "");
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const highlightSourceRef = useRef<"keyboard" | "pointer" | "programmatic">("programmatic");
  const searchRef = useRef<HTMLInputElement>(null);

  // Pin focus on the search input and silently revalidate the cached catalog.
  useEffect(() => {
    setTimeout(() => searchRef.current?.focus(), 10);
    void refreshModelsSilently(sessionId);
  }, [refreshModelsSilently, sessionId]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return availableModels;
    return availableModels.filter((m) => {
      const label = m.name ?? m.id;
      return (
        label.toLowerCase().includes(q) ||
        m.id.toLowerCase().includes(q) ||
        (m.provider ?? "").toLowerCase().includes(q)
      );
    });
  }, [availableModels, query]);

  // Reset highlight when the filter changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: depends on the filter value, not on identity
  useEffect(() => {
    highlightSourceRef.current = "programmatic";
    setHighlightedIndex(0);
  }, [query]);

  const virtualList = useVirtualList<HTMLDivElement>({
    count: filtered.length,
    rowHeight: 38,
    minOverscan: 32,
    overscanScreens: 2,
  });

  useEffect(() => {
    highlightSourceRef.current = "programmatic";
    setHighlightedIndex((i) => (filtered.length === 0 ? 0 : Math.min(i, filtered.length - 1)));
  }, [filtered.length]);

  // Scroll keyboard/programmatic highlight changes into view. Pointer hover
  // only updates the visual highlight; it must not auto-scroll the list.
  useEffect(() => {
    if (highlightSourceRef.current === "pointer") return;
    virtualList.ensureIndexVisible(highlightedIndex);
  }, [highlightedIndex, virtualList.ensureIndexVisible]);

  return (
    <div className="picker picker--model">
      <div className="picker__title">Switch model</div>
      <div className="picker__search">
        <input
          ref={searchRef}
          className="picker__search-input"
          placeholder="Search models…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              highlightSourceRef.current = "keyboard";
              setHighlightedIndex((i) => Math.min(i + 1, filtered.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              highlightSourceRef.current = "keyboard";
              setHighlightedIndex((i) => Math.max(i - 1, 0));
            } else if (e.key === "Enter") {
              e.preventDefault();
              const m = filtered[highlightedIndex];
              if (m) onPick(m);
            } else if (e.key === "Escape") {
              e.preventDefault();
              onClose();
            }
          }}
        />
      </div>
      <ScrollFadeFrame
        frameClassName="picker__list-frame"
        scrollerRef={virtualList.containerRef}
        onScroll={virtualList.onScroll}
        className="picker__list picker__list--virtual"
        role="listbox"
        fill
      >
        {filtered.length === 0 && <div className="picker__empty">No models found</div>}
        {filtered.length > 0 && (
          <div className="picker__virtual-spacer" style={{ height: virtualList.totalHeight }}>
            <div
              className="picker__virtual-window"
              style={{ transform: `translateY(${virtualList.offsetY}px)` }}
            >
              {virtualList.rows.map(({ index: idx }) => {
                const m = filtered[idx];
                if (!m) return null;
                const label = modelDisplayName(m);
                const selected = selectedKey != null && modelKey(m) === selectedKey;
                return (
                  <button
                    type="button"
                    key={modelKey(m)}
                    className={`picker__item ${idx === highlightedIndex ? "picker__item--highlighted" : ""} ${selected ? "picker__item--selected" : ""}`}
                    onClick={() => onPick(m)}
                    onMouseEnter={() => {
                      highlightSourceRef.current = "pointer";
                      setHighlightedIndex(idx);
                    }}
                    role="option"
                    aria-selected={selected}
                  >
                    <span className="picker__selected-mark" aria-hidden>
                      {selected ? "✓" : ""}
                    </span>
                    <span className="picker__item-name" title={label}>
                      {label}
                    </span>
                    <span className="picker__item-meta">{m.id}</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </ScrollFadeFrame>
      <div className="picker__footer">
        {refreshFailed && (
          <button
            type="button"
            className="picker__btn"
            onClick={() => void refreshModelsSilently(sessionId)}
          >
            {availableModels.length === 0 ? "Try again" : "Refresh models"}
          </button>
        )}
        <button type="button" className="picker__btn picker__btn--cancel" onClick={onClose}>
          Cancel
        </button>
      </div>
    </div>
  );
}

// ── /fork picker ────────────────────────────────────────────────────────

function ForkPicker({
  messages,
  onClose,
  onPick,
}: {
  messages: Array<{ entryId: string; text: string }>;
  onClose: () => void;
  onPick: (entryId: string) => void;
}): React.ReactElement {
  const [highlightedIndex, setHighlightedIndex] = useState(messages.length - 1);
  const highlightSourceRef = useRef<"keyboard" | "pointer" | "programmatic">("programmatic");
  const listRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Map<number, HTMLButtonElement>>(new Map());
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const t = setTimeout(() => rootRef.current?.focus(), 10);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    highlightSourceRef.current = "programmatic";
    setHighlightedIndex(messages.length - 1);
  }, [messages.length]);

  useEffect(() => {
    if (highlightSourceRef.current === "pointer") return;
    const btn = itemRefs.current.get(highlightedIndex);
    btn?.scrollIntoView({ block: "nearest" });
  }, [highlightedIndex]);

  return (
    <div
      className="picker picker--fork"
      ref={rootRef}
      tabIndex={-1}
      onKeyDown={(e) => {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          highlightSourceRef.current = "keyboard";
          setHighlightedIndex((i) => Math.min(i + 1, messages.length - 1));
        } else if (e.key === "ArrowUp") {
          e.preventDefault();
          highlightSourceRef.current = "keyboard";
          setHighlightedIndex((i) => Math.max(i - 1, 0));
        } else if (e.key === "Enter") {
          e.preventDefault();
          const m = messages[highlightedIndex];
          if (m) onPick(m.entryId);
        } else if (e.key === "Escape") {
          e.preventDefault();
          onClose();
        }
      }}
    >
      <div className="picker__title">Fork from user message</div>
      <ScrollFadeFrame
        frameClassName="picker__list-frame"
        scrollerRef={listRef}
        className="picker__list"
        role="listbox"
        fill
      >
        {messages.map((m, idx) => {
          const preview = m.text.split("\n", 1)[0] ?? m.text;
          const truncated = preview.length > 96 ? `${preview.slice(0, 96)}…` : preview;
          return (
            <button
              type="button"
              key={m.entryId}
              ref={(el) => {
                if (el) itemRefs.current.set(idx, el);
                else itemRefs.current.delete(idx);
              }}
              className={`picker__item fade-scope ${idx === highlightedIndex ? "picker__item--highlighted" : ""}`}
              onClick={() => onPick(m.entryId)}
              onMouseEnter={() => {
                highlightSourceRef.current = "pointer";
                setHighlightedIndex(idx);
              }}
              role="option"
              aria-selected={idx === highlightedIndex}
            >
              <FadeText className="picker__item-name">{truncated}</FadeText>
            </button>
          );
        })}
      </ScrollFadeFrame>
      <div className="picker__footer">
        <button type="button" className="picker__btn picker__btn--cancel" onClick={onClose}>
          Cancel
        </button>
      </div>
    </div>
  );
}

// ── /resume picker ──────────────────────────────────────────────────────

function ResumePicker({
  sessions,
  onClose,
  onPick,
}: {
  sessions: SessionSummary[];
  onClose: () => void;
  onPick: (s: SessionSummary) => void;
}): React.ReactElement {
  const [query, setQuery] = useState("");
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const searchRef = useRef<HTMLInputElement>(null);
  const itemRefs = useRef<Map<number, HTMLButtonElement>>(new Map());

  useEffect(() => {
    setTimeout(() => searchRef.current?.focus(), 10);
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return sessions;
    return sessions.filter((s) => {
      return (s.name ?? "").toLowerCase().includes(q) || s.preview.toLowerCase().includes(q);
    });
  }, [sessions, query]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: depends on the filter value, not on identity
  useEffect(() => {
    setHighlightedIndex(0);
  }, [query]);

  return (
    <div className="picker picker--resume">
      <div className="picker__title">Resume session</div>
      <div className="picker__search">
        <input
          ref={searchRef}
          className="picker__search-input"
          placeholder="Search sessions…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setHighlightedIndex((i) => Math.min(i + 1, filtered.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setHighlightedIndex((i) => Math.max(i - 1, 0));
            } else if (e.key === "Enter") {
              e.preventDefault();
              const s = filtered[highlightedIndex];
              if (s) onPick(s);
            } else if (e.key === "Escape") {
              e.preventDefault();
              onClose();
            }
          }}
        />
      </div>
      <ScrollFadeFrame
        frameClassName="picker__list-frame"
        className="picker__list"
        role="listbox"
        fill
      >
        {filtered.length === 0 && <div className="picker__empty">No sessions found</div>}
        {filtered.map((s, idx) => (
          <button
            type="button"
            key={s.filePath}
            ref={(el) => {
              if (el) itemRefs.current.set(idx, el);
              else itemRefs.current.delete(idx);
            }}
            className={`picker__item fade-scope ${idx === highlightedIndex ? "picker__item--highlighted" : ""}`}
            onClick={() => onPick(s)}
            onMouseEnter={() => setHighlightedIndex(idx)}
            role="option"
            aria-selected={idx === highlightedIndex}
          >
            <FadeText className="picker__item-name">
              {s.name ?? s.preview ?? s.filePath.split("/").pop()}
            </FadeText>
            <span className="picker__item-meta">{s.messageCount} messages</span>
          </button>
        ))}
      </ScrollFadeFrame>
      <div className="picker__footer">
        <button type="button" className="picker__btn picker__btn--cancel" onClick={onClose}>
          Cancel
        </button>
      </div>
    </div>
  );
}

// ── /scoped-models picker ──────────────────────────────────────────────────
// Multi-select checkbox list of models. Pre-checks enabledIds (or all when
// enabledIds === null, meaning no scope = everything available). Two submit
// actions mirror pi's TUI showModelsSelector:
//   - Apply (persist=false): set_scoped_models — THIS session only, lost on
//     /reload (a fresh process rebuilds from settingsManager.getEnabledModels()).
//   - Save to settings (persist=true): save_scoped_models — persists to pi's
//     settings.json so ALL sessions (current + future + after reload) honor
//     it, AND applies to the current session immediately.
// "Select all" / "Select none" are bulk-toggle helpers that update only the
// local checked set (no submit). On submit, sends the checked provider/id
// strings, or null if everything is checked (mirrors pi's submit logic).
function ScopedModelsPicker({
  models,
  enabledIds,
  onClose,
  onApply,
}: {
  models: ModelInfo[];
  enabledIds: string[] | null;
  onClose: () => void;
  onApply: (enabledIds: string[] | null, persist: boolean) => void;
}): React.ReactElement {
  const allIds = useMemo(() => models.map((m) => `${m.provider ?? ""}/${m.id}`), [models]);
  const [checked, setChecked] = useState<Set<string>>(() => {
    if (enabledIds === null) return new Set(allIds);
    return new Set(enabledIds);
  });
  const [query, setQuery] = useState("");
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const highlightSourceRef = useRef<"keyboard" | "pointer" | "programmatic">("programmatic");
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setTimeout(() => searchRef.current?.focus(), 10);
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return models;
    return models.filter((m) => {
      const label = m.name ?? m.id;
      return (
        label.toLowerCase().includes(q) ||
        m.id.toLowerCase().includes(q) ||
        (m.provider ?? "").toLowerCase().includes(q)
      );
    });
  }, [models, query]);

  // Reset highlight when the filter changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: depends on the filter value, not on identity
  useEffect(() => {
    highlightSourceRef.current = "programmatic";
    setHighlightedIndex(0);
  }, [query]);

  const virtualList = useVirtualList<HTMLDivElement>({
    count: filtered.length,
    rowHeight: 38,
    minOverscan: 32,
    overscanScreens: 2,
  });

  useEffect(() => {
    highlightSourceRef.current = "programmatic";
    setHighlightedIndex((i) => (filtered.length === 0 ? 0 : Math.min(i, filtered.length - 1)));
  }, [filtered.length]);

  useEffect(() => {
    if (highlightSourceRef.current === "pointer") return;
    virtualList.ensureIndexVisible(highlightedIndex);
  }, [highlightedIndex, virtualList.ensureIndexVisible]);

  const toggle = (id: string) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const allChecked = checked.size === allIds.length;
  const noneChecked = checked.size === 0;
  const selectedCount = checked.size;

  const handleApply = (persist: boolean) => {
    // pi convention: all checked → setScopedModels([]) (empty = no scope).
    if (allChecked || checked.size === 0) {
      onApply(null, persist);
      return;
    }
    onApply([...checked], persist);
  };

  return (
    <div className="picker picker--scoped-models">
      <div className="picker__title">Model scope</div>
      <div className="picker__search">
        <input
          ref={searchRef}
          className="picker__search-input"
          placeholder="Search models…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              highlightSourceRef.current = "keyboard";
              setHighlightedIndex((i) => Math.min(i + 1, filtered.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              highlightSourceRef.current = "keyboard";
              setHighlightedIndex((i) => Math.max(i - 1, 0));
            } else if (e.key === "Enter") {
              e.preventDefault();
              const m = filtered[highlightedIndex];
              if (m) toggle(`${m.provider ?? ""}/${m.id}`);
            } else if (e.key === "Escape") {
              e.preventDefault();
              onClose();
            }
          }}
        />
      </div>
      <ScrollFadeFrame
        frameClassName="picker__list-frame"
        scrollerRef={virtualList.containerRef}
        onScroll={virtualList.onScroll}
        className="picker__list picker__list--virtual"
        role="listbox"
        fill
      >
        {filtered.length === 0 && <div className="picker__empty">No models found</div>}
        {filtered.length > 0 && (
          <div className="picker__virtual-spacer" style={{ height: virtualList.totalHeight }}>
            <div
              className="picker__virtual-window"
              style={{ transform: `translateY(${virtualList.offsetY}px)` }}
            >
              {virtualList.rows.map(({ index: idx }) => {
                const m = filtered[idx];
                if (!m) return null;
                const id = `${m.provider ?? ""}/${m.id}`;
                const isChecked = checked.has(id);
                const label = modelDisplayName(m);
                return (
                  <button
                    type="button"
                    key={id}
                    className={`picker__item picker__item--check ${idx === highlightedIndex ? "picker__item--highlighted" : ""}`}
                    onClick={() => toggle(id)}
                    onMouseEnter={() => {
                      highlightSourceRef.current = "pointer";
                      setHighlightedIndex(idx);
                    }}
                    role="option"
                    aria-selected={isChecked}
                  >
                    <span
                      className={`picker__checkbox ${isChecked ? "picker__checkbox--checked" : ""}`}
                      aria-hidden="true"
                    />
                    <span className="picker__item-name" title={label}>
                      {label}
                    </span>
                    <span className="picker__item-meta">{m.id}</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </ScrollFadeFrame>
      <div className="picker__footer">
        <span className="picker__count">
          {selectedCount} of {models.length} selected
        </span>
        <button
          type="button"
          className="picker__btn picker__btn--cancel picker__btn--bulk"
          onClick={() => setChecked(new Set(allIds))}
          disabled={allChecked}
        >
          Select all
        </button>
        <button
          type="button"
          className="picker__btn picker__btn--cancel picker__btn--bulk"
          onClick={() => setChecked(new Set())}
          disabled={noneChecked}
        >
          Select none
        </button>
        <button type="button" className="picker__btn picker__btn--cancel" onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="picker__btn picker__btn--primary"
          onClick={() => handleApply(false)}
        >
          Apply
        </button>
        <button
          type="button"
          className="picker__btn picker__btn--save"
          onClick={() => handleApply(true)}
        >
          Save to settings
        </button>
      </div>
    </div>
  );
}

// ── /login picker ───────────────────────────────────────────────────────────
function LoginPicker({
  providers,
  onClose,
  onPick,
}: {
  providers: LoginProvider[];
  onClose: () => void;
  onPick: (provider: LoginProvider, authType: "oauth" | "api_key") => void;
}): React.ReactElement {
  const [query, setQuery] = useState("");
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const searchRef = useRef<HTMLInputElement>(null);
  const itemRefs = useRef<Map<number, HTMLButtonElement>>(new Map());
  const choices = useMemo(
    () =>
      providers.flatMap((provider) => provider.methods.map((authType) => ({ provider, authType }))),
    [providers],
  );
  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return choices;
    return choices.filter(({ provider, authType }) =>
      `${provider.name} ${provider.id} ${authType === "oauth" ? "oauth" : "api key"}`
        .toLowerCase()
        .includes(normalized),
    );
  }, [choices, query]);

  useEffect(() => {
    const timer = window.setTimeout(() => searchRef.current?.focus(), 10);
    return () => window.clearTimeout(timer);
  }, []);
  useEffect(() => {
    setHighlightedIndex((index) =>
      filtered.length === 0 ? 0 : Math.min(index, filtered.length - 1),
    );
  }, [filtered.length]);
  useEffect(() => {
    itemRefs.current.get(highlightedIndex)?.scrollIntoView({ block: "nearest" });
  }, [highlightedIndex]);

  const choose = (index: number): void => {
    const choice = filtered[index];
    if (choice) onPick(choice.provider, choice.authType);
  };

  return (
    <div className="picker picker--login">
      <div className="picker__title">Sign in</div>
      <div className="picker__search">
        <input
          ref={searchRef}
          className="picker__search-input"
          placeholder="Search providers…"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setHighlightedIndex(0);
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setHighlightedIndex((index) => Math.min(index + 1, filtered.length - 1));
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setHighlightedIndex((index) => Math.max(index - 1, 0));
            } else if (event.key === "Enter") {
              event.preventDefault();
              choose(highlightedIndex);
            } else if (event.key === "Escape") {
              event.preventDefault();
              onClose();
            }
          }}
        />
      </div>
      <ScrollFadeFrame
        frameClassName="picker__list-frame"
        className="picker__list"
        role="listbox"
        fill
      >
        {filtered.length === 0 && <div className="picker__empty">No providers found</div>}
        {filtered.map(({ provider, authType }, index) => (
          <button
            type="button"
            key={`${provider.id}:${authType}`}
            ref={(element) => {
              if (element) itemRefs.current.set(index, element);
              else itemRefs.current.delete(index);
            }}
            className={`picker__item fade-scope ${index === highlightedIndex ? "picker__item--highlighted" : ""}`}
            onClick={() => choose(index)}
            onMouseEnter={() => setHighlightedIndex(index)}
            role="option"
            aria-selected={index === highlightedIndex}
          >
            <FadeText className="picker__item-name">{provider.name}</FadeText>
            {provider.configured && <span className="picker__badge">Connected</span>}
            <span className={`picker__badge picker__badge--${authType}`}>
              {authType === "oauth" ? "OAuth" : "API key"}
            </span>
          </button>
        ))}
      </ScrollFadeFrame>
      <div className="picker__footer">
        <button type="button" className="picker__btn picker__btn--cancel" onClick={onClose}>
          Cancel
        </button>
      </div>
    </div>
  );
}

// ── /logout picker ──────────────────────────────────────────────────────────
// Single-select list of providers with stored auth. On pick, sends
// logout_provider and toasts the result (the message differs for oauth vs
// api_key, mirroring pi's TUI).
function LogoutPicker({
  providers,
  onClose,
  onPick,
}: {
  providers: Array<{ id: string; name: string; authType: "oauth" | "api_key" }>;
  onClose: () => void;
  onPick: (provider: { id: string; name: string; authType: "oauth" | "api_key" }) => void;
}): React.ReactElement {
  const [query, setQuery] = useState("");
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const highlightSourceRef = useRef<"keyboard" | "pointer" | "programmatic">("programmatic");
  const searchRef = useRef<HTMLInputElement>(null);
  const itemRefs = useRef<Map<number, HTMLButtonElement>>(new Map());

  useEffect(() => {
    setTimeout(() => searchRef.current?.focus(), 10);
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return providers;
    return providers.filter((p) => {
      return p.name.toLowerCase().includes(q) || p.id.toLowerCase().includes(q);
    });
  }, [providers, query]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: depends on the filter value, not on identity
  useEffect(() => {
    highlightSourceRef.current = "programmatic";
    setHighlightedIndex(0);
  }, [query]);

  useEffect(() => {
    if (highlightSourceRef.current === "pointer") return;
    const btn = itemRefs.current.get(highlightedIndex);
    btn?.scrollIntoView({ block: "nearest" });
  }, [highlightedIndex]);

  return (
    <div className="picker picker--logout">
      <div className="picker__title">Sign out</div>
      <div className="picker__search">
        <input
          ref={searchRef}
          className="picker__search-input"
          placeholder="Search providers…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              highlightSourceRef.current = "keyboard";
              setHighlightedIndex((i) => Math.min(i + 1, filtered.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              highlightSourceRef.current = "keyboard";
              setHighlightedIndex((i) => Math.max(i - 1, 0));
            } else if (e.key === "Enter") {
              e.preventDefault();
              const p = filtered[highlightedIndex];
              if (p) onPick(p);
            } else if (e.key === "Escape") {
              e.preventDefault();
              onClose();
            }
          }}
        />
      </div>
      <ScrollFadeFrame
        frameClassName="picker__list-frame"
        className="picker__list"
        role="listbox"
        fill
      >
        {filtered.length === 0 && <div className="picker__empty">No providers found</div>}
        {filtered.map((p, idx) => (
          <button
            type="button"
            key={p.id}
            ref={(el) => {
              if (el) itemRefs.current.set(idx, el);
              else itemRefs.current.delete(idx);
            }}
            className={`picker__item fade-scope ${idx === highlightedIndex ? "picker__item--highlighted" : ""}`}
            onClick={() => onPick(p)}
            onMouseEnter={() => {
              highlightSourceRef.current = "pointer";
              setHighlightedIndex(idx);
            }}
            role="option"
            aria-selected={idx === highlightedIndex}
          >
            <FadeText className="picker__item-name">{p.name}</FadeText>
            <span className={`picker__badge picker__badge--${p.authType}`}>
              {p.authType === "oauth" ? "OAuth" : "API Key"}
            </span>
          </button>
        ))}
      </ScrollFadeFrame>
      <div className="picker__footer">
        <button type="button" className="picker__btn picker__btn--cancel" onClick={onClose}>
          Cancel
        </button>
      </div>
    </div>
  );
}

// ── /trust picker ───────────────────────────────────────────────────────────
// Single-select list of pi's project-trust options for the session cwd
// (mirrors pi's TUI TrustSelectorComponent). On pick, persists the chosen
// option's updates via the host's set_trust bridge command and reloads the
// session so the new decision takes effect (pi's TUI also tells the user
// "Restart pi for this to take effect.").
//
// Reload rather than live re-bind: re-running createAgentSessionServices
// mid-session would risk the transcript/session identity. The persisted
// decision is read by resolveProjectTrust on the next session start, so a
// /reload (which re-spawns the host) honors it immediately — faithful to
// pi's TUI, which likewise requires a restart.
function TrustPicker({
  sessionId,
  runtime,
  cwd,
  savedDecision,
  projectTrusted,
  options,
  onClose,
}: {
  sessionId: SessionId;
  runtime: { hostInstanceId: string; sessionEpoch: number };
  cwd: string;
  savedDecision: boolean | null;
  projectTrusted: boolean;
  options: Array<{ label: string; trusted: boolean; updates: unknown[] }>;
  onClose: () => void;
}): React.ReactElement {
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const [saving, setSaving] = useState(false);
  const highlightSourceRef = useRef<"keyboard" | "pointer" | "programmatic">("programmatic");
  const itemRefs = useRef<Map<number, HTMLButtonElement>>(new Map());
  const addToast = useSessionsStore((s) => s.addToast);
  const closePicker = useSessionsStore((s) => s.closePicker);

  // Mirror pi-vis's other pickers: auto-focus the list so arrow-key nav
  // works without a search field (the trust option set is small and fixed).
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    setTimeout(() => listRef.current?.focus(), 10);
  }, []);

  useEffect(() => {
    if (highlightSourceRef.current === "pointer") return;
    const btn = itemRefs.current.get(highlightedIndex);
    btn?.scrollIntoView({ block: "nearest" });
  }, [highlightedIndex]);

  const choose = useCallback(
    async (idx: number) => {
      const option = options[idx];
      if (!option || saving) return;
      // Session-only options have updates === []: set_trust persists nothing,
      // so a reload re-runs resolveProjectTrust with no saved decision and
      // re-prompts — destroying the session-only choice. Session-only trust
      // is a runtime override pi applies only during the initial resolve;
      // it can't be toggled post-startup via /trust. Surface that without a
      // no-op RPC round-trip.
      if (Array.isArray(option.updates) && option.updates.length === 0) {
        addToast(
          sessionId,
          "Session-only trust can't be changed after startup — choose a persistent option.",
          "warning",
        );
        return;
      }
      setSaving(true);
      const semantic = useSessionsStore.getState().sessions.get(sessionId)
        ?.authorityProjection?.semantic;
      const cursor =
        semantic?.state === "following" &&
        semantic.cursor.hostInstanceId === runtime.hostInstanceId &&
        semantic.cursor.sessionEpoch === runtime.sessionEpoch
          ? semantic.cursor
          : undefined;
      const observation = { owner: runtime, ...(cursor ? { cursor } : {}) };
      const isCurrent = () => {
        const session = useSessionsStore.getState().sessions.get(sessionId);
        if (!sessionMatchesRuntime(session, runtime)) return false;
        if (!cursor) return true;
        const current = session?.authorityProjection?.semantic;
        return (
          current?.state === "following" &&
          current.cursor.hostInstanceId === cursor.hostInstanceId &&
          current.cursor.sessionEpoch === cursor.sessionEpoch &&
          current.cursor.transportSequence === cursor.transportSequence &&
          current.cursor.snapshotSequence === cursor.snapshotSequence
        );
      };
      try {
        const receipt = await dispatchSessionIntent(
          sessionId,
          {
            kind: "invokeCommand",
            text: `/trust ${option.trusted ? "trust" : "untrust"}`,
            editorRevision:
              useSessionsStore.getState().sessions.get(sessionId)?.editorRevision ?? 0,
          },
          observation,
        );
        if (!isCurrent()) return;
        if (receipt.status === "not_admitted" || receipt.status === "delivery_unknown") {
          addToast(sessionId, "Failed to request trust update", "error");
          setSaving(false);
          return;
        }
        // Trust changes take effect through the same owner-bound replacement
        // protocol; authority frames publish the successor.
        const reloadReceipt = await dispatchSessionIntent(
          sessionId,
          { kind: "reload" },
          observation,
        );
        if (!isCurrent()) return;
        if (
          reloadReceipt.status === "not_admitted" ||
          reloadReceipt.status === "delivery_unknown"
        ) {
          addToast(
            sessionId,
            "Trust was requested; it applies on the next session start.",
            "warning",
          );
          setSaving(false);
          return;
        }
        closePicker(sessionId);
      } catch (err) {
        if (!isCurrent()) return;
        addToast(sessionId, err instanceof Error ? err.message : String(err), "error");
        setSaving(false);
      }
    },
    [options, saving, sessionId, addToast, closePicker, runtime],
  );

  return (
    <div className="picker picker--trust">
      <div className="picker__title">Project trust</div>
      <FadeText head className="picker__trust-cwd" title={cwd}>
        {cwd}
      </FadeText>
      <div className="picker__trust-status">
        {savedDecision === null
          ? "No saved decision"
          : savedDecision
            ? "Currently trusted (this folder)"
            : "Currently untrusted (this folder)"}
        {!projectTrusted && " · global default: untrusted"}
      </div>
      <ScrollFadeFrame
        frameClassName="picker__list-frame"
        scrollerRef={listRef}
        className="picker__list"
        role="listbox"
        aria-label="Trust options"
        tabIndex={0}
        fill
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            highlightSourceRef.current = "keyboard";
            setHighlightedIndex((i) => Math.min(i + 1, options.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            highlightSourceRef.current = "keyboard";
            setHighlightedIndex((i) => Math.max(i - 1, 0));
          } else if (e.key === "Enter") {
            e.preventDefault();
            void choose(highlightedIndex);
          } else if (e.key === "Escape") {
            e.preventDefault();
            onClose();
          }
        }}
      >
        {options.map((option, idx) => (
          <button
            key={option.label}
            ref={(el) => {
              if (el) itemRefs.current.set(idx, el);
              else itemRefs.current.delete(idx);
            }}
            type="button"
            className={`picker__item fade-scope ${idx === highlightedIndex ? "picker__item--highlighted" : ""}`}
            disabled={saving}
            onMouseEnter={() => {
              highlightSourceRef.current = "pointer";
              setHighlightedIndex(idx);
            }}
            onClick={() => void choose(idx)}
          >
            <FadeText className="picker__item-name">{option.label}</FadeText>
            <span className="picker__item-meta">{option.trusted ? "trusted" : "untrusted"}</span>
          </button>
        ))}
      </ScrollFadeFrame>
      <div className="picker__footer">
        <button
          type="button"
          className="picker__btn picker__btn--cancel"
          onClick={onClose}
          disabled={saving}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
