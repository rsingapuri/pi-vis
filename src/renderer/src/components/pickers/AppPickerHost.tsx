import type { SessionId } from "@shared/ids.js";
import type { SessionSummary } from "@shared/ipc-contract.js";
import type { ModelInfo } from "@shared/pi-protocol/responses.js";
import type React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PickerRequest } from "../../lib/commands/execute.js";
import { useSessionsStore } from "../../stores/sessions-store.js";
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
  const applyModelChange = useSessionsStore((s) => s.applyModelChange);
  const addToast = useSessionsStore((s) => s.addToast);
  const injectEditorText = useSessionsStore((s) => s.injectEditorText);
  const openSessionTab = useSessionsStore((s) => s.openSessionTab);
  const setActiveSession = useSessionsStore((s) => s.setActiveSession);

  if (!picker) return null;

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
            if (!model.provider) return;
            const res = await applyModelChange(sessionId, model);
            if (res.ok) {
              addToast(sessionId, `Model: ${model.id}`);
            } else {
              addToast(sessionId, `Failed to set model: ${res.error}`, "error");
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
            const res = (await window.pivis.invoke("session.sendCommand", {
              sessionId,
              command: { type: "fork", entryId },
            })) as {
              success: boolean;
              data?: { text?: string; cancelled?: boolean };
              error?: string;
            };
            if (!res.success) {
              addToast(sessionId, res.error ?? "Failed to fork", "error");
              closePicker(sessionId);
              return;
            }
            if (res.data?.cancelled) {
              closePicker(sessionId);
              return;
            }
            // TUI prefills the editor with the forked-from text. The
            // fileChanged event (emitted by main) takes care of the
            // transcript reset and tab re-pointing; we only need to
            // prefill the composer.
            if (res.data?.text) {
              injectEditorText(sessionId, res.data.text);
            }
            addToast(sessionId, "Forked to new session");
            // The fileChanged event will close the picker via state
            // replacement (adoptSessionFile resets the session but
            // doesn't clear pendingPicker). Close it manually for the
            // in-place UX.
            closePicker(sessionId);
          }}
        />
      )}
      {picker.kind === "resume" && (
        <ResumePicker
          sessions={picker.sessions}
          onClose={() => closePicker(sessionId)}
          onPick={async (target) => {
            // Focus an existing tab if the file is already open, else
            // open a new tab. `openSessionTab` returns the id either way.
            const liveTab = Array.from(useSessionsStore.getState().sessions.values()).find(
              (s) => s.sessionFile === target.filePath,
            );
            if (liveTab) {
              setActiveSession(liveTab.sessionId);
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
            const id = await openSessionTab(workspacePath, target.filePath, { focus: true });
            if (id) setActiveSession(id);
            closePicker(sessionId);
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
  const availableModels = useSessionsStore((s) => s.sessions.get(sessionId)?.availableModels ?? []);
  const [query, setQuery] = useState(search ?? "");
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const searchRef = useRef<HTMLInputElement>(null);
  const itemRefs = useRef<Map<number, HTMLButtonElement>>(new Map());

  // Pin focus on the search input the moment the picker mounts.
  useEffect(() => {
    setTimeout(() => searchRef.current?.focus(), 10);
  }, []);

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
    setHighlightedIndex(0);
  }, [query]);

  // Scroll the highlighted item into view.
  useEffect(() => {
    const btn = itemRefs.current.get(highlightedIndex);
    btn?.scrollIntoView({ block: "nearest" });
  }, [highlightedIndex]);

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
              setHighlightedIndex((i) => Math.min(i + 1, filtered.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
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
      <div className="picker__list" role="listbox">
        {filtered.length === 0 && <div className="picker__empty">No models found</div>}
        {filtered.map((m, idx) => {
          const label = m.name ?? m.id;
          return (
            <button
              type="button"
              key={m.id}
              ref={(el) => {
                if (el) itemRefs.current.set(idx, el);
                else itemRefs.current.delete(idx);
              }}
              className={`picker__item ${idx === highlightedIndex ? "picker__item--highlighted" : ""}`}
              onClick={() => onPick(m)}
              onMouseEnter={() => setHighlightedIndex(idx)}
              role="option"
              aria-selected={idx === highlightedIndex}
            >
              <span className="picker__item-name">{label}</span>
              <span className="picker__item-meta">
                {m.provider}/{m.id}
              </span>
            </button>
          );
        })}
      </div>
      <div className="picker__footer">
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
  const listRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Map<number, HTMLButtonElement>>(new Map());
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const t = setTimeout(() => rootRef.current?.focus(), 10);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    setHighlightedIndex(messages.length - 1);
  }, [messages.length]);

  useEffect(() => {
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
          setHighlightedIndex((i) => Math.min(i + 1, messages.length - 1));
        } else if (e.key === "ArrowUp") {
          e.preventDefault();
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
      <div className="picker__list" ref={listRef} role="listbox">
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
              className={`picker__item ${idx === highlightedIndex ? "picker__item--highlighted" : ""}`}
              onClick={() => onPick(m.entryId)}
              onMouseEnter={() => setHighlightedIndex(idx)}
              role="option"
              aria-selected={idx === highlightedIndex}
            >
              <span className="picker__item-name">{truncated}</span>
            </button>
          );
        })}
      </div>
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
      <div className="picker__list" role="listbox">
        {filtered.length === 0 && <div className="picker__empty">No sessions found</div>}
        {filtered.map((s, idx) => (
          <button
            type="button"
            key={s.filePath}
            ref={(el) => {
              if (el) itemRefs.current.set(idx, el);
              else itemRefs.current.delete(idx);
            }}
            className={`picker__item ${idx === highlightedIndex ? "picker__item--highlighted" : ""}`}
            onClick={() => onPick(s)}
            onMouseEnter={() => setHighlightedIndex(idx)}
            role="option"
            aria-selected={idx === highlightedIndex}
          >
            <span className="picker__item-name">
              {s.name ?? s.preview ?? s.filePath.split("/").pop()}
            </span>
            <span className="picker__item-meta">{s.messageCount} messages</span>
          </button>
        ))}
      </div>
      <div className="picker__footer">
        <button type="button" className="picker__btn picker__btn--cancel" onClick={onClose}>
          Cancel
        </button>
      </div>
    </div>
  );
}
